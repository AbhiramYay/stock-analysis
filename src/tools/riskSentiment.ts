// ─────────────────────────────────────────────────────────────────────────────
//  src/tools/riskSentiment.ts
//  Portfolio risk and sentiment analysis for holdings
// ─────────────────────────────────────────────────────────────────────────────

import { DynamicStructuredTool } from "@langchain/core/tools";
import { subDays, format } from "date-fns";
import { getHoldingsRaw } from "./getHoldings";
import { fetchHistoricalPrices, fetchYahooSector } from "../utils/kiteClient";
import {
  analyzeSentimentHybrid,
  analyzeSentimentHybridBatch,
  fetchNewsHeadlines,
  normalizeSymbol,
  classifySentiment,
} from "../utils/newsSentiment";
import { convertKeywordSentiment } from "../utils/llmSentiment";
import { scopedLogger } from "../utils/logger";
import { rankRiskSummaries } from "../utils/riskRanking";
import type {
  Holding,
  PortfolioRiskSentimentReport,
  RiskAction,
  StockRiskMetrics,
  EnhancedSentimentResult,
} from "../types/index";

const log = scopedLogger("riskSentiment");
type UnrankedStockRiskMetrics = Omit<StockRiskMetrics, "priorityRank" | "categoryRank" | "rankingScore">;

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
  TATM: "Consumer Discretionary",
  TATAMTRDVR: "Consumer Discretionary",
  ICICIGI: "Financials",
  MRF: "Consumer Discretionary",
};

function getSector(symbol: string): string {
  return SECTOR_MAP[normalizeSymbol(symbol)] ?? "Unknown";
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

function cumulativeReturnPct(returns: number[]): number | null {
  if (returns.length === 0) return null;
  return (returns.reduce((total, value) => total * (1 + value), 1) - 1) * 100;
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
  precomputedSentiment?: EnhancedSentimentResult
): Promise<UnrankedStockRiskMetrics> {
  const symbol = normalizeSymbol(holding.symbol);
  const from = subDays(new Date(), lookbackDays);

  const candles = await fetchHistoricalPrices(symbol, from, new Date(), holding.exchange);
  const { dates, returns } = calculateDailyReturns(candles);

  const volatilityAnnual = returns.length > 0
    ? standardDeviation(returns) * Math.sqrt(252) * 100
    : 0;

  let beta: number | null = null;
  const aligned = alignReturns({ dates, returns }, referenceReturns);
  const periodReturnPct = cumulativeReturnPct(returns);
  const alignedStockReturnPct = cumulativeReturnPct(aligned.a);
  const alignedBenchmarkReturnPct = cumulativeReturnPct(aligned.b);
  const benchmarkRelativeReturnPct = alignedStockReturnPct === null || alignedBenchmarkReturnPct === null
    ? null
    : alignedStockReturnPct - alignedBenchmarkReturnPct;
  if (aligned.a.length >= 10 && referenceReturns.returns.length >= 10) {
    const varBenchmark = variance(aligned.b);
    if (varBenchmark > 0) {
      beta = covariance(aligned.a, aligned.b) / varBenchmark;
    }
  }

  let recentHeadlines: string[] = [];
  let sentiment: EnhancedSentimentResult;
  if (precomputedSentiment) {
    sentiment = precomputedSentiment;
    recentHeadlines = precomputedSentiment ? (precomputedSentiment.keyFindings?.length ? precomputedSentiment.keyFindings : []) : [];
  } else {
    recentHeadlines = await fetchNewsHeadlines(symbol);
    try {
      sentiment = await analyzeSentimentHybrid(recentHeadlines, symbol);
    } catch (err) {
      sentiment = convertKeywordSentiment(classifySentiment(recentHeadlines));
    }
  }
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

  const riskOverlayMessages: string[] = [];
  let adjustedConviction = sentiment.recommendation.conviction;
  let riskReviewRequired = false;
  if (hiddenRiskFlags.length > 0) {
    riskReviewRequired = true;
    adjustedConviction = Math.max(0.05, adjustedConviction - 0.25);
    riskOverlayMessages.push(
      `Risk flags present: ${hiddenRiskFlags.join("; ")}. Conviction reduced to ${adjustedConviction.toFixed(2)}.`
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
    sectorWeightPct: Number((sectorWeights[sector] ?? 0).toFixed(2)),
    periodReturnPct: periodReturnPct === null ? null : Number(periodReturnPct.toFixed(2)),
    benchmarkRelativeReturnPct:
      benchmarkRelativeReturnPct === null ? null : Number(benchmarkRelativeReturnPct.toFixed(2)),
    volatilityAnnual: Number(volatilityAnnual.toFixed(2)),
    beta: beta === null ? null : Number(beta.toFixed(2)),
    averageCorrelation: Number((symbolCorrelations[symbol] ?? 0).toFixed(2)),
    topCorrelatedSymbol: topCorrelationPartner,
    topCorrelation: topCorrelationValue === null ? null : Number(topCorrelationValue.toFixed(2)),
    recentHeadlines,
    sentimentScore: sentiment.score as -1 | 0 | 1,
    sentimentLabel: sentiment.label,
    sentimentConfidence: Number(sentiment.confidence.toFixed(2)),
    sentimentThemes: sentiment.themes,
    sentimentAspects: sentiment.aspects,
    sentimentMethod: sentiment.method,
    sentimentReasoning: sentiment.reasoning,
    sentimentRecommendation: sentiment.recommendation,
    sentimentRecommendationConviction: Number(adjustedConviction.toFixed(2)),
    riskOverlayNote: riskOverlayMessages.join(" "),
    riskReviewRequired,
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

  log.debug("Starting risk and sentiment analysis", { lookbackDays, symbols: holdings.map((h) => h.symbol) });

  const sectorWeights = await computeSectorWeights(holdings);

  const benchmarkReturns = await computeBenchmarkReturns(lookbackDays);
  const benchmarkSymbol = benchmarkReturns.dates.length ? "NIFTYBEES" : null;

  const symbolCorrelationAverages = await computePairwiseCorrelations(holdings, lookbackDays);

  const stockSummaries: UnrankedStockRiskMetrics[] = [];
  const sectorRiskAlerts: string[] = [];
  const overallRecommendations: string[] = [];
  const riskHighlights: string[] = [];

  // Gather headlines for all holdings, then call LLM once for batched sentiment
  const headlineItems: Array<{ symbol: string; headlines: string[] }> = [];
  for (const holding of holdings) {
    const symbol = normalizeSymbol(holding.symbol);
    try {
      const headlines = await fetchNewsHeadlines(symbol);
      headlineItems.push({ symbol, headlines });
    } catch (err) {
      headlineItems.push({ symbol, headlines: [] });
    }
  }

  const sentimentMap = await analyzeSentimentHybridBatch(headlineItems as any);

  for (const holding of holdings) {
    const symbol = normalizeSymbol(holding.symbol);
    const partnerCorrelationEntries = Object.entries(symbolCorrelationAverages)
      .filter(([key]) => key !== symbol)
      .sort((a, b) => b[1] - a[1]);

    const topCorrelationPartner = partnerCorrelationEntries[0]?.[0] ?? null;
    const topCorrelationValue = partnerCorrelationEntries[0]?.[1] ?? null;

    const precomputedSentiment = sentimentMap[symbol];

    const summary = await computeStockRiskMetrics(
      holding,
      benchmarkReturns,
      sectorWeights,
      symbolCorrelationAverages,
      topCorrelationPartner,
      topCorrelationValue,
      lookbackDays,
      precomputedSentiment
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

  const rankedStockSummaries = rankRiskSummaries(stockSummaries);

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
    stockSummaries: rankedStockSummaries,
    overallRecommendations,
    riskHighlights,
    generatedAt: new Date(),
  };
}

const riskSentimentToolConfig: any = {
  name: "riskSentiment",
  description:
    "Analyse portfolio risk and market sentiment for holdings. Computes volatility, beta, sector concentration, and sentiment from recent headlines. " +
    "Returns stock-level risk metrics, sentiment scoring, and actionable adjustment recommendations.",
  schema: undefined as any,
  func: async ({ lookbackDays = 90 }: { lookbackDays?: number }): Promise<string> => {
    log.debug("Tool invoked: riskSentiment", { lookbackDays });
    try {
      const report = await analyzePortfolioRiskSentiment(lookbackDays);
      return JSON.stringify(report, null, 2);
    } catch (err) {
      const msg = `riskSentiment failed: ${(err as Error).message}`;
      log.error(msg);
      return JSON.stringify({ error: msg });
    }
  },
};

export const riskSentimentTool = new DynamicStructuredTool(riskSentimentToolConfig) as unknown as DynamicStructuredTool;
