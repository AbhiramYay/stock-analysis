// ─────────────────────────────────────────────────────────────────────────────
//  src/tools/getHoldings.ts
//  LangChain tool: fetch current portfolio holdings from Zerodha Kite
// ─────────────────────────────────────────────────────────────────────────────

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { fetchHoldings } from "../utils/kiteClient";
import { scopedLogger } from "../utils/logger";
import type { GetHoldingsOutput, Holding, KiteHolding } from "../types/index";

const log = scopedLogger("getHoldings");

// ─── Holding Enrichment ───────────────────────────────────────────────────────

/**
 * Transform raw Kite holdings into enriched Holding objects with
 * computed current values and portfolio weights.
 */
function enrichHoldings(raw: KiteHolding[]): { holdings: Holding[]; totalValue: number } {
  // Filter out zero-quantity holdings (already sold / t1 positions)
  const active = raw.filter((h) => h.quantity > 0);

  // First pass: compute values
  const withValues = active.map((h) => ({
    symbol: h.tradingsymbol,
    exchange: h.exchange,
    isin: h.isin,
    quantity: h.quantity,
    averagePrice: h.average_price,
    lastPrice: h.last_price,
    currentValue: h.last_price * h.quantity,
    pnl: h.pnl,
    dayChange: h.day_change,
    dayChangePercent: h.day_change_percentage,
    weight: 0, // computed in second pass
  }));

  const totalValue = withValues.reduce((sum, h) => sum + h.currentValue, 0);

  // Second pass: compute weights
  const holdings: Holding[] = withValues.map((h) => ({
    ...h,
    weight: totalValue > 0 ? (h.currentValue / totalValue) * 100 : 0,
  }));

  return { holdings, totalValue };
}

// ─── LangChain Tool Definition ────────────────────────────────────────────────

const getHoldingsToolSchema: any = z.object({});
const getHoldingsToolFunc: any = async (): Promise<string> => {
  log.info("Tool invoked: getHoldings");

  try {
    const rawHoldings = await fetchHoldings();
    const { holdings, totalValue } = enrichHoldings(rawHoldings);

    const totalPnL = holdings.reduce((sum, h) => sum + h.pnl, 0);

    const output: GetHoldingsOutput = {
      holdings,
      totalValue,
      totalPnL,
    };

    log.info("Holdings fetched", {
      count: holdings.length,
      totalValue: `₹${totalValue.toFixed(2)}`,
      totalPnL: `₹${totalPnL.toFixed(2)}`,
    });

    return JSON.stringify(output, null, 2);
  } catch (err) {
    const msg = `getHoldings failed: ${(err as Error).message}`;
    log.error(msg);
    return JSON.stringify({ error: msg });
  }
};

export const getHoldingsTool: any = new (DynamicStructuredTool as any)({
  name: "getHoldings",
  description:
    "Fetch the current equity portfolio holdings from Zerodha Kite Connect. " +
    "Returns each stock's symbol, quantity, average buy price, current market price, " +
    "current value, unrealised PnL, and its percentage weight in the total portfolio. " +
    "Call this first before any rebalancing calculation.",
  schema: getHoldingsToolSchema,
  func: getHoldingsToolFunc,
});

// ─── Exported helper (for agent to call directly without LangChain) ───────────

export async function getHoldingsRaw(): Promise<GetHoldingsOutput> {
  const rawHoldings = await fetchHoldings();
  const { holdings, totalValue } = enrichHoldings(rawHoldings);
  const totalPnL = holdings.reduce((sum, h) => sum + h.pnl, 0);
  return { holdings, totalValue, totalPnL };
}
