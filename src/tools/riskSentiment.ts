// ─────────────────────────────────────────────────────────────────────────────
//  src/tools/riskSentiment.ts
//  Portfolio risk and sentiment analysis for holdings
// ─────────────────────────────────────────────────────────────────────────────

import axios from "axios";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { subDays, format } from "date-fns";
import { getHoldingsRaw } from "./getHoldings";
import { fetchHistoricalPrices, fetchYahooSector } from "../utils/kiteClient";
import { scopedLogger } from "../utils/logger";
import type {
  Holding,
  PortfolioRiskSentimentReport,
  RiskAction,
  SentimentLabel,
  StockRiskMetrics,
} from "../types/index";

const log = scopedLogger("riskSentiment");

const SECTOR_MAP: Record<string, string> = {
  INFY: "Information Technology",
  TCS: "Information Technology",
  WIPRO: "Information Technology",
  HCLTECH: "Information Technology",
  TECHM: "Information Technology",
  HDFCBANK: "Financials",
  HDFC: "Financials",
  ICICIBANK: "Financials",
  KOTAKBANK: "Financials",
  AXISBANK: "Financials",
  SBIN: "Financials",
  RELIANCE: "Energy",
  BPCL: "Energy",
  ONGC: "Energy",
  NTPC: "Utilities",
  POWERGRID: "Utilities",
  IOC: "Energy",
  MARUTI: "Consumer Discretionary",
  LT: "Industrials",
  AXIS: "Financials",
  NIFTYBEES: "ETF",
  JSWSTEEL: "Materials",
  TATASTEEL: "Materials",
  ULTRACEMCO: "Materials",
  ITC: "Consumer Staples",
  HINDUNILVR: "Consumer Staples",
  NESTLEIND: "Consumer Staples",
  BHARTIARTL: "Communication Services",
  IDEA: "Communication Services",
  BHARTI: "Communication Services",
  ADANIENT: "Industrials",
  ADANIGREEN: "Utilities",
  ADANIPORTS: "Industrials",
  TITAN: "Consumer Discretionary",
  BAJFINANCE: "Financials",
  BAJAJ_AUTO: "Consumer Discretionary",
  BAJAJFINSV: "Financials",
  HINDALCO: "Materials",
  COALINDIA: "Materials",
  TATAMOTORS: "Consumer Discretionary",
  TATAMTRDVR: "Consumer Discretionary",
  AXISBANK: "Financials",
  ICICIGI: "Financials",
  MRF: "Consumer Discretionary",
};

const POSITIVE_WORDS = [
  "beat",
  "beats",
  "upgrade",
  "upgraded",
  "strong",
  "buoyant",
  "gain",
  "gains",
  "rally",
  "profit",
  "profits",
  "growth",
  "optimistic",
  "outperform",
  "outperforms",
  "record",
  "surge",
  "upside",
  "positive",
  "bullish",
  "rebound",
  "shock"
];

const NEGATIVE_WORDS = [
  "miss",
  "misses",
  "downgrade",
  "downgraded",
  "weak",
  "fall",
  "falls",
  "loss",
  "losses",
  "cut",
  "cuts",
  "sell",
  "selloff",
  "decline",
  "declines",
  "concern",
  "concerns",
  "probe",
  "issue",
  "issues",
  "slowdown",
  "warning",
  "negative",
  "bearish",
  "risk",
  "risks",
  "volatile",
  "volatility",
  "uncertain",
  "concern"
];

const YAHOO_RSS = (symbol: string) =>
  `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=IN&lang=en-IN`;
const GOOGLE_RSS = (symbol: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(symbol + " stock india")}&hl=en-IN&gl=IN&ceid=IN:en`;

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function getSector(symbol: string): string {
  return SECTOR_MAP[normalizeSymbol(symbol)] ?? "Unknown";
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const resolvedSectorCache = new Map<string, string>();

function sectorCacheKey(symbol: string, exchange: string): string {
  return `${normalizeSymbol(symbol)}:${exchange}`;
}

async function resolveSector(symbol: string, exchange: string): Promise<string> {
  const key = sectorCacheKey(symbol, exchange);
  if (resolvedSectorCache.has(key)) {
    return resolvedSectorCache.get(key)!;
  }

  const staticSector = getSector(symbol);
  const yahooSector = await fetchYahooSector(symbol, exchange);
  const sector = yahooSector ?? staticSector;
  resolvedSectorCache.set(key, sector);
  return sector;
}

function scoreHeadlineSentiment(title: string): number {
  const tokens = tokenize(title);
  let score = 0;
  for (const token of tokens) {
    if (POSITIVE_WORDS.includes(token)) score += 1;
    if (NEGATIVE_WORDS.includes(token)) score -= 1;
  }
  return score;
}

function classifySentiment(headlines: string[]): {
  score: number;
  label: SentimentLabel;
  reasoning: string;
} {
  if (headlines.length === 0) {
    return {
      score: 0,
      label: "neutral",
      reasoning: "No recent headlines were available for sentiment classification.",
    };
  }

  const scores = headlines.map((headline) => scoreHeadlineSentiment(headline));
  const total = scores.reduce((sum, value) => sum + value, 0);
  const average = total / headlines.length;

  const positiveCount = scores.filter((value) => value > 0).length;
  const negativeCount = scores.filter((value) => value < 0).length;
  const neutralCount = scores.filter((value) => value === 0).length;

  const label: SentimentLabel = average >= 0.25
    ? "positive"
    : average <= -0.25
    ? "negative"
    : "neutral";

  const reasoning = `Analysed ${headlines.length} headlines: ${positiveCount} positive, ${negativeCount} negative, ${neutralCount} neutral. ` +
    `Overall sentiment is ${label} (avg score ${average.toFixed(2)}).`;

  return {
    score: label === "positive" ? 1 : label === "negative" ? -1 : 0,
    label,
    reasoning,
  };
}

function parseRssTitles(xml: string): string[] {
  const titles: string[] = [];
  const titleRegex = /<title>(.*?)<\/title>/gi;
  let match: RegExpExecArray | null;

  while ((match = titleRegex.exec(xml)) !== null) {
    const title = match[1].trim();
    if (title && !title.toLowerCase().includes("yahoo finance") && !title.toLowerCase().includes("google news")) {
      titles.push(title);
    }
  }

  return titles;
}

async function fetchNewsHeadlines(symbol: string): Promise<string[]> {
  const normalized = normalizeSymbol(symbol);
  const urls = [YAHOO_RSS(`${normalized}.NS`), GOOGLE_RSS(normalized)];
  const headlines = new Set<string>();

  for (const url of urls) {
    try {
      const response = await axios.get<string>(url, {
        timeout: 9000,
        headers: { Accept: "application/rss+xml, application/xml, text/xml" },
      });
      const items = parseRssTitles(response.data);
      items.slice(0, 6).forEach((title) => headlines.add(title));
    } catch (err) {
      log.warn(`News source failed for ${symbol}`, { url, error: (err as Error).message });
    }
  }

  return Array.from(headlines).slice(0, 6);
}

function calculateDailyReturns(candles: Array<{ date: Date; close: number }>): { dates: string[]; returns: number[] } {
  const dates: string[] = [];
  const returns: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const previous = candles[i - 1];
    const current = candles[i];
    if (previous.close > 0) {
      returns.push((current.close - previous.close) / previous.close);
      dates.push(format(current.date, "yyyy-MM-dd"));
    }
  }
  return { dates, returns };
}

function variance(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
}

function standardDeviation(values: number[]): number {
  return Math.sqrt(variance(values));
}

function covariance(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n === 0) return 0;

  const meanX = x.slice(0, n).reduce((sum, value) => sum + value, 0) / n;
  const meanY = y.slice(0, n).reduce((sum, value) => sum + value, 0) / n;
  return x.slice(0, n).reduce((sum, value, index) => sum + (value - meanX) * (y[index] - meanY), 0) / n;
}

function correlation(x: number[], y: number[]): number {
  const cov = covariance(x, y);
  const stdX = standardDeviation(x);
  const stdY = standardDeviation(y);
  if (stdX === 0 || stdY === 0) return 0;
  return Math.max(-1, Math.min(1, cov / (stdX * stdY)));
}

function alignReturns(
  seriesA: { dates: string[]; returns: number[] },
  seriesB: { dates: string[]; returns: number[] }
): { a: number[]; b: number[] } {
  const dateToReturnB = new Map(seriesB.dates.map((date, idx) => [date, seriesB.returns[idx]]));
  const alignedA: number[] = [];
  const alignedB: number[] = [];

  for (let i = 0; i < seriesA.dates.length; i += 1) {
    const date = seriesA.dates[i];
    const valueB = dateToReturnB.get(date);
    if (valueB !== undefined) {
      alignedA.push(seriesA.returns[i]);
      alignedB.push(valueB);
    }
  }

  return { a: alignedA, b: alignedB };
}

async function computeStockRiskMetrics(
  holding: Holding,
  referenceReturns: { dates: string[]; returns: number[] },
  sectorWeights: Record<string, number>,
  symbolCorrelations: Record<string, number>,
  topCorrelationPartner: string | null,
  topCorrelationValue: number | null,
  lookbackDays: number,
): Promise<StockRiskMetrics> {
  const symbol = normalizeSymbol(holding.symbol);
  const from = subDays(new Date(), lookbackDays);

  const candles = await fetchHistoricalPrices(symbol, from, new Date(), holding.exchange);
  const { dates, returns } = calculateDailyReturns(candles);

  const volatilityAnnual = returns.length > 0
    ? standardDeviation(returns) * Math.sqrt(252) * 100
    : 0;

  let beta: number | null = null;
  const aligned = alignReturns({ dates, returns }, referenceReturns);
  if (aligned.a.length >= 10 && referenceReturns.returns.length >= 10) {
    const varBenchmark = variance(aligned.b);
    if (varBenchmark > 0) {
      beta = covariance(aligned.a, aligned.b) / varBenchmark;
    }
  }

  const recentHeadlines = await fetchNewsHeadlines(symbol);
  const sentiment = classifySentiment(recentHeadlines);
  const weight = Number(holding.weight.toFixed(2));
  const sector = await resolveSector(symbol, holding.exchange);

  const hiddenRiskFlags: string[] = [];
  if (beta !== null && beta > 1.2) {
    hiddenRiskFlags.push(`Beta is high (${beta.toFixed(2)})`);
  }
  if (topCorrelationValue !== null && topCorrelationValue > 0.85 && topCorrelationPartner) {
    hiddenRiskFlags.push(
      `Highly correlated with ${topCorrelationPartner} (r=${topCorrelationValue.toFixed(2)})`
    );
  }
  if (sectorWeights[sector] && sectorWeights[sector] > 35) {
    hiddenRiskFlags.push(
      `Sector concentration in ${sector} is ${sectorWeights[sector].toFixed(1)}%`
    );
  }

  let recommendedAction: RiskAction = "HOLD";
  if (sentiment.score === -1) {
    recommendedAction = hiddenRiskFlags.length > 0 ? "REDUCE" : "CONSIDER REDUCE";
  } else if (sentiment.score === 1) {
    recommendedAction = "CONSIDER INCREASE";
  }
  if (sectorWeights[sector] > 40 && sentiment.score === 1) {
    recommendedAction = "CONSIDER REDUCE";
  }

  return {
    symbol,
    sector,
    weight,
    volatilityAnnual: Number(volatilityAnnual.toFixed(2)),
    beta: beta === null ? null : Number(beta.toFixed(2)),
    averageCorrelation: Number((symbolCorrelations[symbol] ?? 0).toFixed(2)),
    topCorrelatedSymbol: topCorrelationPartner,
    topCorrelation: topCorrelationValue === null ? null : Number(topCorrelationValue.toFixed(2)),
    recentHeadlines,
    sentimentScore: sentiment.score,
    sentimentLabel: sentiment.label,
    sentimentReasoning: sentiment.reasoning,
    hiddenRiskFlags,
    recommendedAction,
  };
}

async function computeSectorWeights(holdings: Holding[]): Promise<Record<string, number>> {
  const sectorWeights: Record<string, number> = {};
  for (const holding of holdings) {
    const sector = await resolveSector(holding.symbol, holding.exchange);
    sectorWeights[sector] = (sectorWeights[sector] ?? 0) + holding.weight;
  }
  return sectorWeights;
}

async function computeBenchmarkReturns(lookbackDays: number): Promise<{ dates: string[]; returns: number[] }> {
  const benchmark = "NIFTYBEES";
  const from = subDays(new Date(), lookbackDays);
  const candles = await fetchHistoricalPrices(benchmark, from, new Date(), "NSE");
  if (candles.length < 10) {
    return { dates: [], returns: [] };
  }
  return calculateDailyReturns(candles);
}

async function computePairwiseCorrelations(holdings: Holding[], lookbackDays: number): Promise<Record<string, number>> {
  const seriesBySymbol: Record<string, { dates: string[]; returns: number[] }> = {};

  for (const holding of holdings) {
    const candles = await fetchHistoricalPrices(normalizeSymbol(holding.symbol), subDays(new Date(), lookbackDays), new Date(), holding.exchange);
    seriesBySymbol[normalizeSymbol(holding.symbol)] = calculateDailyReturns(candles);
  }

  const correlations: Record<string, number[]> = {};

  const symbols = holdings.map((holding) => normalizeSymbol(holding.symbol));
  for (let i = 0; i < symbols.length; i += 1) {
    const symbolA = symbols[i];
    correlations[symbolA] = [];
    for (let j = 0; j < symbols.length; j += 1) {
      if (i === j) continue;
      const symbolB = symbols[j];
      const seriesA = seriesBySymbol[symbolA];
      const seriesB = seriesBySymbol[symbolB];
      if (!seriesA || !seriesB) continue;
      const aligned = alignReturns(seriesA, seriesB);
      correlations[symbolA].push(correlation(aligned.a, aligned.b));
    }
  }

  return Object.fromEntries(
    Object.entries(correlations).map(([symbol, values]) => [
      symbol,
      values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : 0,
    ])
  );
}

export async function analyzePortfolioRiskSentiment(
  lookbackDays = 90
): Promise<PortfolioRiskSentimentReport> {
  const { holdings } = await getHoldingsRaw();
  if (holdings.length === 0) {
    throw new Error("No holdings found. Portfolio risk and sentiment analysis requires at least one stock.");
  }

  log.info("Starting risk and sentiment analysis", { lookbackDays, symbols: holdings.map((h) => h.symbol) });

  const sectorWeights = await computeSectorWeights(holdings);

  const benchmarkReturns = await computeBenchmarkReturns(lookbackDays);
  const benchmarkSymbol = benchmarkReturns.dates.length ? "NIFTYBEES" : null;

  const symbolCorrelationAverages = await computePairwiseCorrelations(holdings, lookbackDays);

  const stockSummaries: StockRiskMetrics[] = [];
  const sectorRiskAlerts: string[] = [];
  const overallRecommendations: string[] = [];
  const riskHighlights: string[] = [];

  for (const holding of holdings) {
    const symbol = normalizeSymbol(holding.symbol);
    const partnerCorrelationEntries = Object.entries(symbolCorrelationAverages)
      .filter(([key]) => key !== symbol)
      .sort((a, b) => b[1] - a[1]);

    const topCorrelationPartner = partnerCorrelationEntries[0]?.[0] ?? null;
    const topCorrelationValue = partnerCorrelationEntries[0]?.[1] ?? null;

    const summary = await computeStockRiskMetrics(
      holding,
      benchmarkReturns,
      sectorWeights,
      symbolCorrelationAverages,
      topCorrelationPartner,
      topCorrelationValue,
      lookbackDays
    );

    stockSummaries.push(summary);
  }

  const portfolioVolatility =
    stockSummaries.length > 0
      ? stockSummaries.reduce((sum, s) => sum + s.volatilityAnnual, 0) / stockSummaries.length
      : 0;

  for (const summary of stockSummaries) {
    if (summary.volatilityAnnual > portfolioVolatility) {
      summary.hiddenRiskFlags.push(
        `Annualised volatility ${summary.volatilityAnnual.toFixed(1)}% is above portfolio average ${portfolioVolatility.toFixed(1)}%`
      );
    }

    if (summary.sentimentScore === 1 && summary.volatilityAnnual <= portfolioVolatility && (summary.beta === null || summary.beta <= 1.2)) {
      summary.recommendedAction = summary.hiddenRiskFlags.length > 0 ? "CONSIDER INCREASE" : "INCREASE";
    }

    if (summary.sentimentScore === -1 && summary.hiddenRiskFlags.length > 0) {
      summary.recommendedAction = "REDUCE";
    }

    if (summary.sentimentScore === -1 && summary.hiddenRiskFlags.length === 0) {
      summary.recommendedAction = "CONSIDER REDUCE";
    }

    if (summary.sector && sectorWeights[summary.sector] > 40 && summary.sentimentScore === 1) {
      summary.recommendedAction = "CONSIDER REDUCE";
    }

    if (summary.recommendedAction !== "HOLD") {
      overallRecommendations.push(
        `${summary.symbol}: ${summary.recommendedAction} — ${summary.sentimentLabel} sentiment, ${summary.hiddenRiskFlags.join("; ") || "no major hidden risks detected"}`
      );
    }
    if (summary.hiddenRiskFlags.length > 0) {
      riskHighlights.push(`${summary.symbol}: ${summary.hiddenRiskFlags.join("; ")}`);
    }
  }

  stockSummaries.sort((a, b) => {
    const sentimentOrder: Record<SentimentLabel, number> = {
      negative: 0,
      neutral: 1,
      positive: 2,
    };
    const actionOrder: Record<RiskAction, number> = {
      REDUCE: 0,
      "CONSIDER REDUCE": 1,
      HOLD: 2,
      "CONSIDER INCREASE": 3,
      INCREASE: 4,
    };

    const sentimentDelta = sentimentOrder[a.sentimentLabel] - sentimentOrder[b.sentimentLabel];
    if (sentimentDelta !== 0) return sentimentDelta;
    return actionOrder[a.recommendedAction] - actionOrder[b.recommendedAction];
  });

  for (const [sector, weight] of Object.entries(sectorWeights)) {
    if (weight >= 35) {
      sectorRiskAlerts.push(`Sector ${sector} is ${weight.toFixed(1)}% of the portfolio.`);
    }
  }

  if (sectorRiskAlerts.length > 0) {
    riskHighlights.unshift(...sectorRiskAlerts);
  }

  if (overallRecommendations.length === 0) {
    overallRecommendations.push("Portfolio appears balanced from a risk and sentiment perspective. Hold positions and monitor headlines.");
  }

  return {
    benchmarkSymbol,
    sectorWeights,
    stockSummaries,
    overallRecommendations,
    riskHighlights,
    generatedAt: new Date(),
  };
}

export const riskSentimentTool = new DynamicStructuredTool({
  name: "riskSentiment",
  description:
    "Analyse portfolio risk and market sentiment for holdings. Computes volatility, beta, sector concentration, and sentiment from recent headlines. " +
    "Returns stock-level risk metrics, sentiment scoring, and actionable adjustment recommendations.",
  schema: z.object({
    lookbackDays: z.number().optional().describe("Number of calendar days to use for historical risk analysis"),
  }),
  func: async ({ lookbackDays = 90 }: { lookbackDays?: number }): Promise<string> => {
    log.info("Tool invoked: riskSentiment", { lookbackDays });
    try {
      const report = await analyzePortfolioRiskSentiment(lookbackDays);
      return JSON.stringify(report, null, 2);
    } catch (err) {
      const msg = `riskSentiment failed: ${(err as Error).message}`;
      log.error(msg);
      return JSON.stringify({ error: msg });
    }
  },
});
