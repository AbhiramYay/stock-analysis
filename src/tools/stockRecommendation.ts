// ─────────────────────────────────────────────────────────────────────────────
//  src/tools/stockRecommendation.ts
//  NSE stock buy recommendations: fundamentals + news/analyst sentiment + diversification
// ─────────────────────────────────────────────────────────────────────────────

import { subMonths } from "date-fns";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { NIFTY_50_SYMBOLS } from "../data/nifty50";
import { getHoldingsRaw } from "./getHoldings";
import { fetchHistoricalPrices, fetchYahooSector } from "../utils/kiteClient";
import { fetchYahooFundamentals } from "../utils/yahooFundamentals";
import {
  analyzeSentimentHybridBatch,
  fetchNewsHeadlines,
  normalizeSymbol,
  classifySentiment,
} from "../utils/newsSentiment";
import { convertKeywordSentiment } from "../utils/llmSentiment";
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
  "Google Gemini LLM multi-source sentiment analysis (headlines + analyst note + earnings excerpt)",
  "Yahoo Finance historical prices (6-month momentum)",
];

const METHODOLOGY =
  "Scores each NSE large-cap on fundamentals (0–40), LLM-enhanced sentiment (0–35), and 6M momentum (0–25). " +
  "A risk overlay penalises weak balance sheet or momentum signals, and top picks are ranked and diversified across sectors (max 2 per sector).";

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

function diversifyPicks(candidates: StockRecommendation[], topN: number): StockRecommendation[] {
  const sorted = [...candidates].sort((a, b) => b.compositeScore - a.compositeScore);
  const picked: StockRecommendation[] = [];
  const sectorCounts: Record<string, number> = {};

  for (const c of sorted) {
    if (picked.length >= topN) break;
    const count = sectorCounts[c.sector] ?? 0;
    if (count >= 2) continue;
    sectorCounts[c.sector] = count + 1;
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

async function buildUniverse(includeHoldings: boolean): Promise<string[]> {
  const symbols = new Set<string>(NIFTY_50_SYMBOLS);
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
  return Array.from(symbols);
}

export interface RecommendStocksOptions {
  topN?: number;
  includeHoldings?: boolean;
  throttleMs?: number;
}

export async function analyzeStockRecommendations(
  options: RecommendStocksOptions = {}
): Promise<StockRecommendationReport> {
  const topN = Math.min(Math.max(options.topN ?? 8, 5), 10);
  const throttleMs = options.throttleMs ?? 350;
  const universe = await buildUniverse(options.includeHoldings ?? true);

  log.info("Starting stock recommendation scan", { universeSize: universe.length, topN });

  const candidates: StockRecommendation[] = [];

  // First pass: gather data for all symbols (fundamentals, headlines, sector, momentum)
  const gathered: Array<{
    symbol: string;
    exchange: string;
    fundamentals: any;
    headlines: string[];
    sector: string | null;
    sixMonthReturnPct: number | null;
  }> = [];

  for (let i = 0; i < universe.length; i += 1) {
    const symbol = universe[i];
    log.debug(`Gathering data ${i + 1}/${universe.length}: ${symbol}`);

    const exchange = "NSE";
    const [fundamentals, headlines, sector, sixMonthReturnPct] = await Promise.all([
      fetchYahooFundamentals(symbol, exchange),
      fetchNewsHeadlines(symbol),
      fetchYahooSector(symbol, exchange),
      fetchSixMonthReturn(symbol, exchange),
    ]);

    gathered.push({ symbol, exchange, fundamentals, headlines, sector: sector ?? null, sixMonthReturnPct });
    await sleep(throttleMs);
  }

  // Call LLM once for all symbols using batched sentiment analysis
  const batchItems = gathered.map((g) => ({ symbol: g.symbol, headlines: g.headlines }));
  const sentimentMap = await analyzeSentimentHybridBatch(batchItems as any);

  // Second pass: score and filter using batched sentiment results
  for (const g of gathered) {
    const symbol = g.symbol;
    const exchange = g.exchange;
    const fundamentals = g.fundamentals;
    const headlines = g.headlines;
    const sector = g.sector;
    const sixMonthReturnPct = g.sixMonthReturnPct;

    const sentiment = sentimentMap[symbol] ?? convertKeywordSentiment(classifySentiment(headlines));
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
    });
  }

  const recommendations = diversifyPicks(candidates, topN);
  const sectorAllocation = buildSectorAllocation(recommendations);

  log.info("Stock recommendations ready", {
    scanned: universe.length,
    passed: candidates.length,
    picked: recommendations.length,
  });

  return {
    recommendations,
    sectorAllocation,
    universeScanned: universe.length,
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
}: {
  topN?: number;
  includeHoldings?: boolean;
}): Promise<string> => {
  log.info("Tool invoked: stockRecommendation", { topN, includeHoldings });
  try {
    const report = await analyzeStockRecommendations({ topN, includeHoldings });
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
    "Generate ranked NSE stock buy recommendations for the Indian market. " +
    "Combines Yahoo Finance fundamentals (ROE, debt/equity, earnings growth), " +
    "news and analyst sentiment from RSS feeds, and 6-month momentum. " +
    "Returns top 5–10 diversified picks with reasoning and sector allocation.",
  schema: stockRecommendationToolSchema,
  func: stockRecommendationToolFunc,
};

export const stockRecommendationTool: any = new (DynamicStructuredTool as any)(stockRecommendationToolConfig);
