// ─────────────────────────────────────────────────────────────────────────────
//  src/tools/placeOrder.ts
//  LangChain tool: place a buy or sell order on Zerodha Kite
// ─────────────────────────────────────────────────────────────────────────────

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { placeKiteOrder } from "../utils/kiteClient";
import { scopedLogger } from "../utils/logger";
import type {
  OrderExchange,
  OrderParams,
  OrderProduct,
  OrderType,
  OrderValidity,
  OrderVariety,
  PlacedOrder,
  PlaceOrderOutput,
  TransactionType,
} from "../types/index";

const log = scopedLogger("placeOrder");

// ─── LangChain Tool Definition ────────────────────────────────────────────────

export const placeOrderTool = new DynamicStructuredTool({
  name: "placeOrder",
  description:
    "Place a BUY or SELL equity order on Zerodha Kite Connect. " +
    "Use MARKET orders for immediate execution at current prices. " +
    "Use LIMIT orders to specify an exact price. " +
    "Product type CNC is for delivery (long-term), MIS for intraday. " +
    "⚠️ This tool executes REAL trades. Only call it after explicit user confirmation.",
  schema: z.object({
    symbol: z.string().min(1).describe("NSE trading symbol, e.g. INFY, TCS"),
    transactionType: z
      .enum(["BUY", "SELL"])
      .describe("Whether to buy or sell the stock"),
    quantity: z.number().describe("Number of shares to buy or sell"),
    orderType: z
      .enum(["MARKET", "LIMIT", "SL", "SL-M"])
      .default("MARKET")
      .optional()
      .describe("Order type: MARKET executes immediately, LIMIT requires a price"),
    price: z
      .number()
      .optional()
      .describe("Limit price (required for LIMIT and SL orders)"),
    exchange: z
      .enum(["NSE", "BSE"])
      .default("NSE")
      .optional()
      .describe("Stock exchange (default NSE)"),
    product: z
      .enum(["CNC", "MIS", "NRML"])
      .default("CNC")
      .optional()
      .describe("Product type: CNC=delivery, MIS=intraday"),
  }),
  func: async ({
    symbol,
    transactionType,
    quantity,
    orderType = "MARKET",
    price,
    exchange = "NSE",
    product = "CNC",
  }: {
    symbol: string;
    transactionType: "BUY" | "SELL";
    quantity: number;
    orderType?: "MARKET" | "LIMIT" | "SL" | "SL-M";
    price?: number;
    exchange?: "NSE" | "BSE";
    product?: "CNC" | "MIS" | "NRML";
  }): Promise<string> => {
    log.info("Tool invoked: placeOrder", {
      symbol,
      transactionType,
      quantity,
      orderType,
      price,
      exchange,
      product,
    });

    if (!Number.isInteger(quantity) || quantity <= 0) {
      const msg = "Quantity must be a positive integer";
      log.error(msg, { quantity });
      return JSON.stringify({ error: msg });
    }

    if (orderType === "LIMIT" && (!price || price <= 0)) {
      const msg = "LIMIT order requires a valid price > 0";
      log.error(msg);
      return JSON.stringify({ error: msg });
    }

    if (price !== undefined && price <= 0) {
      const msg = "Price must be greater than 0 when provided";
      log.error(msg, { price });
      return JSON.stringify({ error: msg });
    }

    // Build order params
    const orderParams: OrderParams = {
      symbol: symbol.toUpperCase(),
      exchange: (exchange ?? "NSE") as OrderExchange,
      transactionType: transactionType as TransactionType,
      quantity,
      orderType: (orderType ?? "MARKET") as OrderType,
      product: (product ?? "CNC") as OrderProduct,
      variety: (process.env.ORDER_VARIETY ?? "regular") as OrderVariety,
      validity: (process.env.ORDER_VALIDITY ?? "DAY") as OrderValidity,
      ...(price !== undefined && { price }),
    };

    try {
      const response = await placeKiteOrder(orderParams);

      const placed: PlacedOrder = {
        orderId: response.order_id,
        symbol: orderParams.symbol,
        transactionType: orderParams.transactionType,
        quantity: orderParams.quantity,
        orderType: orderParams.orderType,
        status: "PLACED",
        message: `Order ${response.order_id} placed successfully`,
        placedAt: new Date(),
      };

      const output: PlaceOrderOutput = {
        orderId: placed.orderId,
        status: "PLACED",
        message: placed.message!,
      };

      log.info(`Order placed`, {
        orderId: placed.orderId,
        symbol,
        action: transactionType,
        qty: quantity,
      });

      return JSON.stringify(output, null, 2);
    } catch (err) {
      const errMsg = (err as Error).message;
      log.error(`placeOrder failed for ${symbol}`, { error: errMsg });

      const output: PlaceOrderOutput = {
        orderId: "",
        status: "FAILED",
        message: `Order failed: ${errMsg}`,
      };

      return JSON.stringify(output, null, 2);
    }
  },
});

// ─── Batch order execution ────────────────────────────────────────────────────

/**
 * Execute multiple orders sequentially with a short delay between each
 * to avoid rate limiting. Returns results for all attempted orders.
 */
export async function executeBatchOrders(
  orders: Array<{
    symbol: string;
    transactionType: TransactionType;
    quantity: number;
    orderType?: OrderType;
    price?: number;
  }>
): Promise<PlacedOrder[]> {
  const results: PlacedOrder[] = [];

  for (const order of orders) {
    log.info(`Executing batch order: ${order.transactionType} ${order.quantity}x ${order.symbol}`);

    const orderParams: OrderParams = {
      symbol: order.symbol.toUpperCase(),
      exchange: (process.env.ORDER_EXCHANGE ?? "NSE") as OrderExchange,
      transactionType: order.transactionType,
      quantity: order.quantity,
      orderType: (order.orderType ?? "MARKET") as OrderType,
      product: (process.env.ORDER_PRODUCT ?? "CNC") as OrderProduct,
      variety: (process.env.ORDER_VARIETY ?? "regular") as OrderVariety,
      validity: (process.env.ORDER_VALIDITY ?? "DAY") as OrderValidity,
      ...(order.price !== undefined && { price: order.price }),
    };

    try {
      const response = await placeKiteOrder(orderParams);
      results.push({
        orderId: response.order_id,
        symbol: orderParams.symbol,
        transactionType: orderParams.transactionType,
        quantity: orderParams.quantity,
        orderType: orderParams.orderType,
        status: "PLACED",
        message: `Order ${response.order_id} placed`,
        placedAt: new Date(),
      });
    } catch (err) {
      results.push({
        orderId: "",
        symbol: order.symbol,
        transactionType: order.transactionType,
        quantity: order.quantity,
        orderType: (order.orderType ?? "MARKET") as OrderType,
        status: "FAILED",
        message: (err as Error).message,
        placedAt: new Date(),
      });
    }

    // Small delay between orders to be a good API citizen
    await new Promise((r) => setTimeout(r, 300));
  }

  return results;
}
