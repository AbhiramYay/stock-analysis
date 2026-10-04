// ─────────────────────────────────────────────────────────────────────────────
//  src/tools/getHistoricalPrice.ts
//  LangChain tool: fetch a stock's closing price on a given date
// ─────────────────────────────────────────────────────────────────────────────

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { format, parseISO, isValid } from "date-fns";
import { fetchHistoricalPrice } from "../utils/kiteClient";
import { scopedLogger } from "../utils/logger";
import type { GetHistoricalPriceOutput } from "../types/index";

const log = scopedLogger("getHistoricalPrice");

// ─── LangChain Tool Definition ────────────────────────────────────────────────

const getHistoricalPriceToolConfig: any = {
  name: "getHistoricalPrice",
  description:
    "Fetch the OHLCV (open, high, low, close, volume) price data for a given stock symbol " +
    "on a specific date. The date must be in YYYY-MM-DD format. " +
    "If the exact date falls on a weekend or holiday, the nearest prior trading day is used. " +
    "Useful for computing monthly PnL or comparing prices over time.",
  schema: z.object({
    symbol: z
      .string()
      .min(1)
      .describe("NSE trading symbol, e.g. INFY, TCS, HDFCBANK"),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
      .describe("Target date in YYYY-MM-DD format"),
    exchange: z
      .enum(["NSE", "BSE"])
      .default("NSE")
      .describe("Stock exchange, defaults to NSE"),
  }),
  func: async ({
    symbol,
    date,
    exchange = "NSE",
  }: {
    symbol: string;
    date: string;
    exchange?: "NSE" | "BSE";
  }): Promise<string> => {
    log.debug(`Tool invoked: getHistoricalPrice`, { symbol, date, exchange });

    // Validate date format
    const parsedDate = parseISO(date);
    if (!isValid(parsedDate)) {
      const msg = `Invalid date format: "${date}". Use YYYY-MM-DD.`;
      log.error(msg);
      return JSON.stringify({ error: msg });
    }

    try {
      const candle = await fetchHistoricalPrice(symbol, parsedDate, exchange);

      if (!candle) {
        const msg = `No price data found for ${exchange}:${symbol} on or before ${date}`;
        log.warn(msg);
        return JSON.stringify({ error: msg, symbol, date });
      }

      const output: GetHistoricalPriceOutput = {
        symbol,
        date: format(candle.date, "yyyy-MM-dd"),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      };

      log.debug(`Historical price fetched`, {
        symbol,
        actualDate: output.date,
        close: output.close,
      });

      return JSON.stringify(output, null, 2);
    } catch (err) {
      const msg = `getHistoricalPrice failed for ${symbol}: ${(err as Error).message}`;
      log.error(msg);
      return JSON.stringify({ error: msg });
    }
  },
};

export const getHistoricalPriceTool = new DynamicStructuredTool(getHistoricalPriceToolConfig) as unknown as DynamicStructuredTool;
