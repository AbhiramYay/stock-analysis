// ─────────────────────────────────────────────────────────────────────────────
//  src/utils/pnl.ts
//  Monthly PnL calculation: compare last month's open vs close for each holding
// ─────────────────────────────────────────────────────────────────────────────

import {
  startOfMonth,
  endOfMonth,
  subMonths,
  format,
} from "date-fns";
import { fetchHistoricalPrice } from "./kiteClient";
import { scopedLogger } from "./logger";
import type {
  Holding,
  StockMonthlyPnL,
  MonthlyPnLReport,
} from "../types/index";

const log = scopedLogger("PnLCalculator");

// ─── Last Month Period Helpers ────────────────────────────────────────────────

/** Returns { from, to } dates for last complete calendar month */
export function getLastMonthPeriod(): { from: Date; to: Date } {
  const now = new Date();
  const lastMonth = subMonths(now, 1);
  return {
    from: startOfMonth(lastMonth),
    to: endOfMonth(lastMonth),
  };
}

// ─── Core PnL Computation ─────────────────────────────────────────────────────

/**
 * Compute last month's gain/loss per stock.
 *
 * Strategy:
 *   1. Fetch the OHLC candle for the first trading day of last month  → openPrice
 *   2. Fetch the OHLC candle for the last trading day of last month   → closePrice
 *   3. pnlAbsolute = (closePrice - openPrice) × quantity
 *   4. pnlPercent   = (closePrice - openPrice) / openPrice × 100
 *
 * @param holdings  Current portfolio holdings (already enriched with weight)
 * @returns         Full monthly PnL report
 */
export async function calculateMonthlyPnL(
  holdings: Holding[]
): Promise<MonthlyPnLReport> {
  const { from, to } = getLastMonthPeriod();

  log.info("Calculating monthly PnL", {
    period: `${format(from, "yyyy-MM-dd")} → ${format(to, "yyyy-MM-dd")}`,
    symbols: holdings.map((h) => h.symbol),
  });

  const stocks: StockMonthlyPnL[] = [];
  let totalPnLAbsolute = 0;
  let totalHoldingValue = 0;

  // Process holdings SEQUENTIALLY to avoid hitting Kite's rate limits.
  //
  // Why not Promise.allSettled?
  //   Each holding needs 3 HTTP requests: instruments list + 2 historical candles.
  //   Running N holdings in parallel fires 3N requests simultaneously, which
  //   triggers Kite's 429 "Too many requests" error on the web OMS endpoint.
  //
  // The instruments list is fetched only ONCE (cached in kiteClient), so the
  //   main cost per holding is just 2 throttled candle requests (~800ms each).
  //   A 10-stock portfolio completes in ~20s — acceptable for a daily workflow.
  for (let i = 0; i < holdings.length; i++) {
    const h = holdings[i];
    log.debug(`PnL progress: ${i + 1}/${holdings.length} — ${h.symbol}`);
    try {
      const result = await computeStockPnL(h, from, to);
      if (result) {
        stocks.push(result);
        totalPnLAbsolute += result.pnlAbsolute;
        totalHoldingValue += result.holdingValue;
      }
    } catch (err) {
      log.warn(`Skipping ${h.symbol} due to error`, {
        error: (err as Error).message,
      });
    }
  }

  const totalPnLPercent =
    totalHoldingValue > 0 ? (totalPnLAbsolute / totalHoldingValue) * 100 : 0;

  // Sort by absolute PnL descending for best/worst
  const sorted = [...stocks].sort((a, b) => b.pnlPercent - a.pnlPercent);
  const bestPerformer = sorted[0] ?? null;
  const worstPerformer = sorted[sorted.length - 1] ?? null;

  const report: MonthlyPnLReport = {
    stocks,
    totalPnLAbsolute,
    totalPnLPercent,
    totalHoldingValue,
    bestPerformer,
    worstPerformer,
    period: { from, to },
    generatedAt: new Date(),
  };

  log.info("Monthly PnL calculated", {
    totalPnL: `₹${totalPnLAbsolute.toFixed(2)}`,
    totalPnLPct: `${totalPnLPercent.toFixed(2)}%`,
    best: bestPerformer?.symbol,
    worst: worstPerformer?.symbol,
  });

  return report;
}

// ─── Per-stock helper ─────────────────────────────────────────────────────────

async function computeStockPnL(
  holding: Holding,
  monthStart: Date,
  monthEnd: Date
): Promise<StockMonthlyPnL | null> {
  const { symbol, exchange, quantity, lastPrice } = holding;

  log.debug(`Fetching historical prices for ${symbol}`, {
    monthStart: format(monthStart, "yyyy-MM-dd"),
    monthEnd: format(monthEnd, "yyyy-MM-dd"),
  });

  // Fetch open price (first trading day of last month)
  const openCandle = await fetchHistoricalPrice(symbol, monthStart, exchange);

  // Fetch close price (last trading day of last month)
  const closeCandle = await fetchHistoricalPrice(symbol, monthEnd, exchange);

  if (!openCandle || !closeCandle) {
    log.warn(`Insufficient historical data for ${symbol}, skipping PnL`);
    return null;
  }

  const openPrice = openCandle.open; // Use month-open's opening price
  const closePrice = closeCandle.close; // Use month-end's closing price

  const priceDelta = closePrice - openPrice;
  const pnlAbsolute = priceDelta * quantity;
  const pnlPercent = openPrice > 0 ? (priceDelta / openPrice) * 100 : 0;
  const holdingValue = quantity * lastPrice;

  return {
    symbol,
    exchange,
    quantity,
    openPrice,
    closePrice,
    currentPrice: lastPrice,
    pnlAbsolute,
    pnlPercent,
    holdingValue,
  };
}

// ─── Formatting Helpers ───────────────────────────────────────────────────────

/** Format a currency value in Indian Rupees */
export function formatINR(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Format a percentage with sign */
export function formatPct(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}
