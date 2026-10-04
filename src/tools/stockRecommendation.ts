// ─────────────────────────────────────────────────────────────────────────────
//  src/tools/stockRecommendation.ts
//  Multi-cap equity recommendations using direct market-data scoring.
// ─────────────────────────────────────────────────────────────────────────────

import { subMonths } from "date-fns";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { NIFTY_50_SYMBOLS } from "../data/nifty50";
import type { MarketCapTier } from "../data/equityUniverse";
import { getHoldingsRaw } from "./getHoldings";
import { fetchHistoricalPrices, fetchNseEquitySymbols, fetchYahooSector } from "../utils/kiteClient";
import { fetchYahooFundamentals } from "../utils/yahooFundamentals";
import { fetchNewsHeadlines, normalizeSymbol, classifySentiment } from "../utils/newsSentiment";
import { convertKeywordSentiment } from "../utils/llmSentiment";
import { scrapeRecommendations, extractScrapedSymbols } from "./brokerageRecommendations";
import { scopedLogger } from "../utils/logger";
import type {
  SentimentLabel,
  StockFundamentals,
  StockRecommendation,
  StockRecommendationReport,
} from "../types/index";

const log = scopedLogger("stockRecommendation");

const DATA_SOURCES = [
  "Yahoo Finance (fundamentals: ROE, debt/equity, earnings growth, P/E)",
  "Yahoo Finance & Google News RSS (headlines, brokerage/analyst tone, earnings context)",
  "Yahoo Finance historical prices (6-month momentum)",
];

const METHODOLOGY =
  "Scores each NSE equity on fundamentals (0–40), sentiment (0–35), and 6M momentum (0–25). " +
  "For multicap analysis, the top-ranked stocks are selected purely on score so the basket is not constrained by sector diversification.";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scoreFundamentals(f: StockFundamentals): { score: number; reasoning: string } {
  const parts: string[] = [];
  let score = 0;

  if (f.roe !== null) {
    if (f.roe >= 18) {
      score += 14;
      parts.push(`ROE ${f.roe.toFixed(1)}% is strong`);
    } else if (f.roe >= 12) {
      score += 10;
      parts.push(`ROE ${f.roe.toFixed(1)}% is healthy`);
    } else if (f.roe >= 8) {
      score += 5;
      parts.push(`ROE ${f.roe.toFixed(1)}% is moderate`);
    } else {
      score += 1;
      parts.push(`ROE ${f.roe.toFixed(1)}% is weak`);
    }
  } else {
    parts.push("ROE data unavailable");
  }

  if (f.earningsGrowth !== null) {
    if (f.earningsGrowth >= 15) {
      score += 14;
      parts.push(`earnings growth ${f.earningsGrowth.toFixed(1)}% is robust`);
    } else if (f.earningsGrowth >= 8) {
      score += 10;
      parts.push(`earnings growth ${f.earningsGrowth.toFixed(1)}% is positive`);
    } else if (f.earningsGrowth >= 0) {
      score += 5;
      parts.push(`earnings growth ${f.earningsGrowth.toFixed(1)}% is modest`);
    } else {
      score += 0;
      parts.push(`earnings growth ${f.earningsGrowth.toFixed(1)}% is negative`);
    }
  } else {
    parts.push("earnings growth data unavailable");
  }

  if (f.debtToEquity !== null) {
    if (f.debtToEquity <= 0.5) {
      score += 12;
      parts.push(`debt/equity ${f.debtToEquity.toFixed(2)} is conservative`);
    } else if (f.debtToEquity <= 1) {
      score += 8;
      parts.push(`debt/equity ${f.debtToEquity.toFixed(2)} is acceptable`);
    } else if (f.debtToEquity <= 1.5) {
      score += 4;
      parts.push(`debt/equity ${f.debtToEquity.toFixed(2)} is elevated`);
    } else {
      parts.push(`debt/equity ${f.debtToEquity.toFixed(2)} is high`);
    }
  } else {
    parts.push("debt/equity data unavailable");
  }

  return {
    score: Math.min(40, score),
    reasoning: parts.join("; ") + ".",
  };
}

function scoreSentiment(
  label: SentimentLabel,
  analystSignals: string[],
  confidence: number
): { score: number; reasoning: string } {
  let score = label === "positive" ? 28 : label === "neutral" ? 16 : 4;
  score = Math.min(35, score + Math.round(confidence * 4));

  if (analystSignals.some((h) => /\b(upgrade|buy|outperform|accumulate)\b/i.test(h))) {
    score = Math.min(35, score + 7);
  }
  if (analystSignals.some((h) => /\b(downgrade|sell|underperform)\b/i.test(h))) {
    score = Math.max(0, score - 10);
  }
  const analystNote =
    analystSignals.length > 0
      ? ` Analyst/brokerage headlines: ${analystSignals.length} signal(s).`
      : "";
  const confidenceNote =
    confidence >= 0.8
      ? " High confidence in the sentiment classification."
      : confidence >= 0.5
      ? " Moderate confidence in the sentiment classification."
      : " Low confidence in the sentiment classification.";

  return {
    score,
    reasoning: `News sentiment is ${label}.${analystNote}${confidenceNote}`,
  };
}

function scoreMomentum(sixMonthReturnPct: number | null): { score: number; reasoning: string } {
  if (sixMonthReturnPct === null) {
    return { score: 10, reasoning: "6-month price trend unavailable." };
  }
  if (sixMonthReturnPct >= 20) {
    return { score: 25, reasoning: `6-month return +${sixMonthReturnPct.toFixed(1)}% shows strong momentum.` };
  }
  if (sixMonthReturnPct >= 8) {
    return { score: 18, reasoning: `6-month return +${sixMonthReturnPct.toFixed(1)}% supports the thesis.` };
  }
  if (sixMonthReturnPct >= 0) {
    return { score: 12, reasoning: `6-month return +${sixMonthReturnPct.toFixed(1)}% is flat-to-positive.` };
  }
  return { score: 4, reasoning: `6-month return ${sixMonthReturnPct.toFixed(1)}% is weak.` };
}

function deriveRiskScore(
  fundamentals: StockFundamentals,
  sixMonthReturnPct: number | null
): { riskScore: number; riskNotes: string[] } {
  const notes: string[] = [];
  let flags = 1;

  if (fundamentals.debtToEquity !== null && fundamentals.debtToEquity > 2) {
    notes.push(`debt/equity ${fundamentals.debtToEquity.toFixed(2)} is elevated`);
    flags += 1;
  }
  if (fundamentals.earningsGrowth !== null && fundamentals.earningsGrowth < 5) {
    notes.push(`earnings growth ${fundamentals.earningsGrowth.toFixed(1)}% is weak`);
    flags += 1;
  }
  if (sixMonthReturnPct !== null && sixMonthReturnPct < 0) {
    notes.push(`momentum is negative at ${sixMonthReturnPct.toFixed(1)}%`);
    flags += 1;
  }

  const riskScore = 35 * (1 / flags);
  return { riskScore, riskNotes: notes };
}

function computeAlphaScore(
  fundamentalScore: number,
  sentimentScore: number,
  riskScore: number
): number {
  const alpha = 0.4 * fundamentalScore + 0.4 * sentimentScore + 0.2 * riskScore;
  return Number(alpha.toFixed(1));
}

async function fetchSixMonthReturn(symbol: string, exchange = "NSE"): Promise<number | null> {
  try {
    const from = subMonths(new Date(), 6);
    const candles = await fetchHistoricalPrices(symbol, from, new Date(), exchange);
    if (candles.length < 2) return null;
    const sorted = [...candles].sort((a, b) => a.date.getTime() - b.date.getTime());
    const first = sorted[0].close;
    const last = sorted[sorted.length - 1].close;
    if (first <= 0) return null;
    return ((last - first) / first) * 100;
  } catch {
    return null;
  }
}

function passesFilters(
  fundamentalScore: number,
  sentimentLabel: SentimentLabel,
  fundamentals: StockFundamentals,
  sixMonthReturnPct: number | null
): boolean {
  if (sentimentLabel === "negative") return false;
  if (fundamentalScore < 12 && (sixMonthReturnPct === null || sixMonthReturnPct < 5)) return false;
  if (fundamentals.roe !== null && fundamentals.roe < 5 && fundamentalScore < 18) return false;
  if (
    fundamentals.debtToEquity !== null &&
    fundamentals.debtToEquity > 2 &&
    fundamentalScore < 20
  ) {
    return false;
  }
  return true;
}

function diversifyPicks(
  candidates: StockRecommendation[],
  topN: number,
  scope: "nifty" | "multicap"
): StockRecommendation[] {
  const sorted = [...candidates].sort((a, b) => b.compositeScore - a.compositeScore);
  const picked: StockRecommendation[] = [];

  if (scope === "nifty") {
    const sectorCounts: Record<string, number> = {};
    const tierCounts: Record<MarketCapTier, number> = { large: 0, mid: 0, small: 0 };

    for (const c of sorted) {
      if (picked.length >= topN) break;
      const count = sectorCounts[c.sector] ?? 0;
      const tier = (c as StockRecommendation & { marketCapTier?: MarketCapTier }).marketCapTier ?? "large";
      if (count >= 2 || tierCounts[tier] >= 3) continue;
      sectorCounts[c.sector] = count + 1;
      tierCounts[tier] += 1;
      picked.push(c);
    }

    if (picked.length < topN) {
      for (const c of sorted) {
        if (picked.length >= topN) break;
        if (picked.some((p) => p.symbol === c.symbol)) continue;
        picked.push(c);
      }
    }

    return picked.map((item, index) => ({ ...item, rank: index + 1 }));
  }

  for (const c of sorted) {
    if (picked.length >= topN) break;
    if (picked.some((p) => p.symbol === c.symbol)) continue;
    picked.push(c);
  }

  return picked.map((item, index) => ({ ...item, rank: index + 1 }));
}

function buildSectorAllocation(recommendations: StockRecommendation[]): Record<string, number> {
  if (recommendations.length === 0) return {};
  const weight = 100 / recommendations.length;
  const allocation: Record<string, number> = {};
  for (const r of recommendations) {
    allocation[r.sector] = (allocation[r.sector] ?? 0) + weight;
  }
  return Object.fromEntries(
    Object.entries(allocation).map(([sector, pct]) => [sector, Number(pct.toFixed(1))])
  );
}

export async function resolveRecommendationUniverse(options: { scope?: "nifty" | "multicap"; includeHoldings?: boolean }): Promise<string[]> {
  const scope = options.scope ?? "multicap";
  if (scope === "nifty") {
    return [...NIFTY_50_SYMBOLS];
  }

  const scrapedRecommendationsResult = await scrapeRecommendations();
  const scrapedSymbols = extractScrapedSymbols(scrapedRecommendationsResult.recommendations);
  if (scrapedSymbols.length > 0) {
    log.info("Using scraped brokerage buy recommendations for multicap universe", {
      count: scrapedSymbols.length,
      source: scrapedRecommendationsResult.source,
    });
    return scrapedSymbols;
  }

  log.warn("No scraped brokerage symbols available for multicap; falling back to dynamic NSE symbol discovery");
  const dynamicSymbols = await fetchNseEquitySymbols(180);
  if (dynamicSymbols.length > 0) {
    return dynamicSymbols;
  }

  log.warn("No dynamic NSE symbols found for multicap universe. Recommendation universe will be empty.");
  return [];
}

async function buildUniverseEntries(includeHoldings: boolean, scope: "nifty" | "multicap") {
  const symbols = new Set<string>(await resolveRecommendationUniverse({ scope }));
  if (includeHoldings) {
    try {
      const { holdings } = await getHoldingsRaw();
      holdings.forEach((h) => symbols.add(normalizeSymbol(h.symbol)));
    } catch (err) {
      log.warn("Could not merge holdings into recommendation universe", {
        error: (err as Error).message,
      });
    }
  }

  return Array.from(symbols).map((symbol) => ({
    symbol,
    exchange: "NSE" as const,
    marketCapTier: "large" as MarketCapTier,
    sector: "Unknown" as string,
  }));
}

export interface RecommendStocksOptions {
  topN?: number;
  includeHoldings?: boolean;
  throttleMs?: number;
  scope?: "nifty" | "multicap";
}

export async function analyzeStockRecommendations(
  options: RecommendStocksOptions = {}
): Promise<StockRecommendationReport> {
  const topN = Math.min(Math.max(options.topN ?? 8, 5), 10);
  const throttleMs = options.throttleMs ?? 350;
  const scope = options.scope ?? "multicap";
  const universeEntries = await buildUniverseEntries(options.includeHoldings ?? true, scope);

  log.debug("Starting stock recommendation scan", { universeSize: universeEntries.length, topN, scope });

  const candidates: StockRecommendation[] = [];
  const gathered: Array<{
    symbol: string;
    exchange: string;
    fundamentals: any;
    headlines: string[];
    sector: string | null;
    sixMonthReturnPct: number | null;
    marketCapTier: MarketCapTier;
  }> = [];

  for (let i = 0; i < universeEntries.length; i += 1) {
    const entry = universeEntries[i];
    log.debug(`Gathering data ${i + 1}/${universeEntries.length}: ${entry.symbol}`);

    const exchange = entry.exchange;
    const [fundamentals, headlines, sector, sixMonthReturnPct] = await Promise.all([
      fetchYahooFundamentals(entry.symbol, exchange),
      fetchNewsHeadlines(entry.symbol),
      fetchYahooSector(entry.symbol, exchange),
      fetchSixMonthReturn(entry.symbol, exchange),
    ]);

    gathered.push({
      symbol: entry.symbol,
      exchange,
      fundamentals,
      headlines,
      sector: sector ?? null,
      sixMonthReturnPct,
      marketCapTier: entry.marketCapTier,
    });
    await sleep(throttleMs);
  }

  for (const g of gathered) {
    const symbol = g.symbol;
    const exchange = g.exchange;
    const fundamentals = g.fundamentals;
    const headlines = g.headlines;
    const sector = g.sector;
    const sixMonthReturnPct = g.sixMonthReturnPct;
    const marketCapTier = g.marketCapTier;

    const sentiment = convertKeywordSentiment(classifySentiment(headlines));
    const fund = scoreFundamentals(fundamentals);
    const sent = scoreSentiment(sentiment.label, sentiment.analystSignals, sentiment.confidence);
    const mom = scoreMomentum(sixMonthReturnPct);
    const { riskScore, riskNotes } = deriveRiskScore(fundamentals, sixMonthReturnPct);

    if (!passesFilters(fund.score, sentiment.label, fundamentals, sixMonthReturnPct)) {
      continue;
    }

    const alphaScore = computeAlphaScore(fund.score, sent.score, riskScore);
    const resolvedSector = sector ?? "Unknown";
    const alphaReasoning = `Alpha score blends fundamentals, sentiment, and risk. Risk adjustment: ${
      riskNotes.length > 0 ? riskNotes.join("; ") : "no major risk flags"
    }.`;

    candidates.push({
      symbol,
      exchange,
      sector: resolvedSector,
      rank: 0,
      compositeScore: alphaScore,
      alphaScore,
      fundamentalScore: fund.score,
      sentimentScore: sent.score,
      sentimentConfidence: sentiment.confidence,
      sentimentThemes: sentiment.themes,
      sentimentAspects: sentiment.aspects,
      sentimentMethod: sentiment.method,
      sentimentRecommendation: sentiment.recommendation,
      sentimentRecommendationConviction: sentiment.recommendation.conviction,
      momentumScore: mom.score,
      sixMonthReturnPct:
        sixMonthReturnPct === null ? null : Number(sixMonthReturnPct.toFixed(2)),
      riskScore: Number(riskScore.toFixed(1)),
      fundamentals,
      sentimentLabel: sentiment.label,
      recentHeadlines: headlines,
      analystSignals: sentiment.analystSignals,
      fundamentalReasoning: fund.reasoning,
      sentimentReasoning: sent.reasoning + " " + sentiment.reasoning,
      combinedReasoning: `${fund.reasoning} ${sent.reasoning} ${mom.reasoning}`,
      alphaReasoning,
      marketCapTier,
    } as StockRecommendation & { marketCapTier: MarketCapTier });
  }

  const recommendations = diversifyPicks(candidates, topN, scope);
  const sectorAllocation = buildSectorAllocation(recommendations);

  log.debug("Stock recommendations ready", {
    scanned: universeEntries.length,
    passed: candidates.length,
    picked: recommendations.length,
    scope,
  });

  return {
    recommendations,
    sectorAllocation,
    universeScanned: universeEntries.length,
    candidatesPassed: candidates.length,
    dataSources: DATA_SOURCES,
    methodology: METHODOLOGY,
    generatedAt: new Date(),
  };
}

const stockRecommendationToolSchema: any = undefined;
const stockRecommendationToolFunc: any = async ({
  topN,
  includeHoldings = true,
  scope = "multicap",
}: {
  topN?: number;
  includeHoldings?: boolean;
  scope?: "nifty" | "multicap";
}): Promise<string> => {
  log.debug("Tool invoked: stockRecommendation", { topN, includeHoldings, scope });
  try {
    const report = await analyzeStockRecommendations({ topN, includeHoldings, scope });
    return JSON.stringify(report, null, 2);
  } catch (err) {
    const msg = `stockRecommendation failed: ${(err as Error).message}`;
    log.error(msg);
    return JSON.stringify({ error: msg });
  }
};

const stockRecommendationToolConfig: any = {
  name: "stockRecommendation",
  description:
    "Generate ranked equity buy recommendations for large-, mid-, and small-cap NSE stocks. " +
    "Combines Yahoo Finance fundamentals, news and analyst sentiment, and 6-month momentum. " +
    "Returns top 5–10 diversified picks with reasoning and sector allocation.",
  schema: stockRecommendationToolSchema,
  func: stockRecommendationToolFunc,
};

export const stockRecommendationTool: any = new (DynamicStructuredTool as any)(stockRecommendationToolConfig);
