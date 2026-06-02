import { scopedLogger } from "./logger";
import { fetchQuoteSummary, yahooTicker } from "./yahooClient";
import type { StockFundamentals } from "../types/index";

const log = scopedLogger("yahooFundamentals");
const cache = new Map<string, StockFundamentals>();

const EMPTY: StockFundamentals = {
  roe: null,
  debtToEquity: null,
  earningsGrowth: null,
  peRatio: null,
};

function yahooRaw(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const raw =
    typeof value === "object" && value !== null && "raw" in value
      ? (value as { raw: number }).raw
      : value;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function asPercent(value: unknown): number | null {
  const n = yahooRaw(value);
  if (n === null) return null;
  if (Math.abs(n) <= 1.5) return n * 100;
  return n;
}

function pickGrowth(stats: Record<string, unknown> | undefined): number | null {
  if (!stats) return null;
  const candidates = [
    stats.earningsGrowth,
    stats.revenueGrowth,
    stats.earningsQuarterlyGrowth,
  ];
  for (const c of candidates) {
    const pct = asPercent(c);
    if (pct !== null) return pct;
  }
  return null;
}

export async function fetchYahooFundamentals(
  symbol: string,
  exchange = "NSE"
): Promise<StockFundamentals> {
  const key = `${symbol}:${exchange}`;
  if (cache.has(key)) return cache.get(key)!;

  const ticker = yahooTicker(symbol, exchange);
  const result = await fetchQuoteSummary(
    ticker,
    "financialData,defaultKeyStatistics,earningsTrend,summaryDetail"
  );

  if (!result) {
    log.warn(`Fundamentals lookup failed for ${symbol} (${ticker})`);
    cache.set(key, { ...EMPTY });
    return { ...EMPTY };
  }

  const financial = (result.financialData ?? {}) as Record<string, unknown>;
  const stats = (result.defaultKeyStatistics ?? {}) as Record<string, unknown>;
  const trend = (result.earningsTrend as { trend?: Array<{ growth?: unknown }> } | undefined)
    ?.trend?.[0];
  const summary = (result.summaryDetail ?? {}) as Record<string, unknown>;

  const roe = asPercent(financial.returnOnEquity ?? stats.returnOnEquity);

  const debtToEquityValue = yahooRaw(financial.debtToEquity ?? stats.debtToEquity);

  let earningsGrowth = pickGrowth(stats);
  if (earningsGrowth === null && trend?.growth !== undefined) {
    earningsGrowth = asPercent(trend.growth);
  }

  const peRatio = yahooRaw(
    financial.forwardPE ??
      stats.forwardPE ??
      stats.trailingPE ??
      summary.trailingPE ??
      summary.forwardPE
  );

  const fundamentals: StockFundamentals = {
    roe,
    debtToEquity: debtToEquityValue,
    earningsGrowth,
    peRatio: peRatio !== null && peRatio > 0 && peRatio < 500 ? peRatio : null,
  };

  cache.set(key, fundamentals);
  return fundamentals;
}
