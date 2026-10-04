// ─────────────────────────────────────────────────────────────────────────────
//  src/tools/rebalancePortfolio.ts
//  LangChain tool: compare current weights vs target weights → trade suggestions
// ─────────────────────────────────────────────────────────────────────────────

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { getHoldingsRaw } from "./getHoldings";
import { scopedLogger } from "../utils/logger";
import type {
  Holding,
  RebalancingPlan,
  TargetWeights,
  TradeSuggestion,
} from "../types/index";

const log = scopedLogger("rebalancePortfolio");

// ─── Core Rebalancing Algorithm ───────────────────────────────────────────────

/**
 * Generate trade suggestions to move from current weights to target weights.
 *
 * Algorithm:
 *   For each symbol in target weights:
 *     currentValue    = holding.quantity × holding.lastPrice
 *     targetValue     = totalPortfolioValue × targetWeight / 100
 *     valueDelta      = targetValue − currentValue
 *     quantity        = floor(|valueDelta| / lastPrice)
 *     if valueDelta > 0  → BUY  `quantity` shares
 *     if valueDelta < 0  → SELL `quantity` shares
 *     if |weightDelta| < driftThreshold → skip (no action needed)
 *
 * @param holdings        Enriched current holdings
 * @param totalValue      Total portfolio value in INR
 * @param targetWeights   Symbol → target % (must sum to 100)
 * @param driftThreshold  Minimum weight deviation to trigger a trade (default 2%)
 */
export function computeRebalancingPlan(
  holdings: Holding[],
  totalValue: number,
  targetWeights: TargetWeights,
  driftThreshold = 2.0
): RebalancingPlan {
  // Validate target weights sum
  const weightSum = Object.values(targetWeights).reduce((s, w) => s + w, 0);
  if (Math.abs(weightSum - 100) > 0.5) {
    throw new Error(
      `Target weights must sum to 100%. Current sum: ${weightSum.toFixed(2)}%`
    );
  }

  const holdingMap = new Map<string, Holding>(
    holdings.map((h) => [h.symbol.toUpperCase(), h])
  );

  const suggestions: TradeSuggestion[] = [];
  const skippedSymbols: string[] = [];

  for (const [rawSymbol, targetWeight] of Object.entries(targetWeights)) {
    const symbol = rawSymbol.toUpperCase();
    const holding = holdingMap.get(symbol);

    const currentPrice = holding?.lastPrice ?? 0;
    const currentValue = holding ? holding.quantity * holding.lastPrice : 0;
    const currentWeight = holding?.weight ?? 0;

    const targetValue = (targetWeight / 100) * totalValue;
    const valueDelta = targetValue - currentValue;
    const weightDelta = targetWeight - currentWeight;

    // Skip if drift is within acceptable threshold
    if (Math.abs(weightDelta) < driftThreshold) {
      skippedSymbols.push(symbol);
      log.debug(`${symbol}: drift ${weightDelta.toFixed(2)}% < threshold, skipping`);
      continue;
    }

    if (currentPrice <= 0) {
      log.warn(`${symbol} has no valid price (not in holdings). Manual lookup required.`);
      skippedSymbols.push(symbol);
      continue;
    }

    const action: "BUY" | "SELL" = valueDelta > 0 ? "BUY" : "SELL";
    const quantity = Math.floor(Math.abs(valueDelta) / currentPrice);

    if (quantity === 0) {
      skippedSymbols.push(symbol);
      continue;
    }

    const estimatedValue = quantity * currentPrice;

    suggestions.push({
      symbol,
      action,
      quantity,
      estimatedPrice: currentPrice,
      estimatedValue,
      currentWeight: parseFloat(currentWeight.toFixed(2)),
      targetWeight: parseFloat(targetWeight.toFixed(2)),
      weightDelta: parseFloat(weightDelta.toFixed(2)),
      reasoning:
        `${symbol} is currently ${currentWeight.toFixed(2)}% of portfolio ` +
        `(target: ${targetWeight.toFixed(2)}%). ` +
        `${action} ${quantity} shares @ ₹${currentPrice.toFixed(2)} ` +
        `(≈₹${estimatedValue.toFixed(2)}) to correct ${weightDelta.toFixed(2)}% drift.`,
    });
  }

  // Sort: sells first (free up cash before buying)
  suggestions.sort((a, b) => {
    if (a.action === "SELL" && b.action === "BUY") return -1;
    if (a.action === "BUY" && b.action === "SELL") return 1;
    return b.estimatedValue - a.estimatedValue;
  });

  const totalBuyValue = suggestions
    .filter((s) => s.action === "BUY")
    .reduce((sum, s) => sum + s.estimatedValue, 0);

  const totalSellValue = suggestions
    .filter((s) => s.action === "SELL")
    .reduce((sum, s) => sum + s.estimatedValue, 0);

  return {
    suggestions,
    totalBuyValue,
    totalSellValue,
    netCashRequired: totalBuyValue - totalSellValue,
    weightDriftThreshold: driftThreshold,
    skippedSymbols,
    generatedAt: new Date(),
  };
}

// ─── LangChain Tool Definition ────────────────────────────────────────────────

const rebalancePortfolioToolConfig: any = {
  name: "rebalancePortfolio",
  description:
    "Compare the current portfolio holdings and their weights against the provided target weights. " +
    "Generates a list of BUY and SELL trade suggestions to bring the portfolio in line with targets. " +
    "Target weights are provided as a JSON object mapping symbols to percentage allocations " +
    "(e.g. {\"INFY\": 30, \"TCS\": 40, \"HDFC\": 30}). They must sum to 100. " +
    "Trades are only suggested for symbols where drift exceeds the driftThreshold (default 2%).",
  schema: z.object({
    targetWeights: z
      .record(z.string(), z.number().min(0).max(100))
      .describe(
        "Map of symbol to target allocation %. Example: {\"INFY\": 30, \"TCS\": 40, \"HDFC\": 30}"
      ),
    driftThreshold: z
      .number()
      .min(0)
      .max(20)
      .default(2)
      .optional()
      .describe("Minimum % weight deviation to trigger a trade suggestion (default: 2%)"),
  }),
  func: async ({
    targetWeights,
    driftThreshold = 2,
  }: {
    targetWeights: TargetWeights;
    driftThreshold?: number;
  }): Promise<string> => {
    log.debug("Tool invoked: rebalancePortfolio", { targetWeights, driftThreshold });

    try {
      // Step 1: Fetch live holdings
      const { holdings, totalValue } = await getHoldingsRaw();

      if (holdings.length === 0) {
        return JSON.stringify({
          error: "No holdings found in portfolio. Please fund your account and hold some stocks.",
        });
      }

      // Step 2: Compute rebalancing plan
      const plan = computeRebalancingPlan(
        holdings,
        totalValue,
        targetWeights,
        driftThreshold
      );

      log.debug("Rebalancing plan generated", {
        trades: plan.suggestions.length,
        totalBuy: `₹${plan.totalBuyValue.toFixed(2)}`,
        totalSell: `₹${plan.totalSellValue.toFixed(2)}`,
        netCash: `₹${plan.netCashRequired.toFixed(2)}`,
        skipped: plan.skippedSymbols,
      });

      return JSON.stringify(plan, null, 2);
    } catch (err) {
      const msg = `rebalancePortfolio failed: ${(err as Error).message}`;
      log.error(msg);
      return JSON.stringify({ error: msg });
    }
  },
};

export const rebalancePortfolioTool = new DynamicStructuredTool(rebalancePortfolioToolConfig) as unknown as DynamicStructuredTool;
