// ─────────────────────────────────────────────────────────────────────────────
//  src/utils/kiteClient.ts
//  Singleton Zerodha KiteConnect client with lazy initialization
// ─────────────────────────────────────────────────────────────────────────────

import { KiteConnect } from "kiteconnect";
import { format, subDays } from "date-fns";
import type {
  KiteHolding,
  KiteOHLC,
  KiteOrderResponse,
  OrderParams,
} from "../types/index";
import { scopedLogger } from "./logger";

const log = scopedLogger("KiteClient");

// ─── Kite Client Singleton ────────────────────────────────────────────────────

let _kiteInstance: KiteConnect | null = null;

/**
 * Returns a lazily-initialized, authenticated KiteConnect instance.
 * Reads credentials from environment variables.
 */
export function getKiteClient(): KiteConnect {
  if (_kiteInstance) return _kiteInstance;

  const apiKey = process.env.KITE_API_KEY;
  const accessToken = process.env.KITE_ACCESS_TOKEN;

  if (!apiKey) {
    throw new Error(
      "KITE_API_KEY is not set. Please check your .env file."
    );
  }
  if (!accessToken) {
    throw new Error(
      "KITE_ACCESS_TOKEN is not set. " +
        "Generate one via the Kite login flow and set it in .env."
    );
  }

  _kiteInstance = new KiteConnect({ api_key: apiKey });
  _kiteInstance.setAccessToken(accessToken);

  log.info("KiteConnect client initialized", { apiKey: `${apiKey.slice(0, 4)}****` });
  return _kiteInstance;
}

// ─── API Wrappers ─────────────────────────────────────────────────────────────

/**
 * Fetch all current equity holdings from the Kite API.
 */
export async function fetchHoldings(): Promise<KiteHolding[]> {
  const kite = getKiteClient();
  log.debug("Fetching holdings from Kite API...");

  try {
    const holdings = (await kite.getHoldings()) as KiteHolding[];
    log.info(`Fetched ${holdings.length} holdings`);
    return holdings;
  } catch (err) {
    log.error("Failed to fetch holdings", { error: (err as Error).message });
    throw new Error(`Kite getHoldings failed: ${(err as Error).message}`);
  }
}

/**
 * Fetch historical OHLCV data for a symbol on a specific date.
 * Falls back to the nearest trading day if the exact date is unavailable.
 *
 * @param symbol   NSE/BSE trading symbol, e.g. "INFY"
 * @param date     Target date (ISO string or Date object)
 * @param exchange Exchange prefix, default "NSE"
 */
export async function fetchHistoricalPrice(
  symbol: string,
  date: Date | string,
  exchange = "NSE"
): Promise<KiteOHLC | null> {
  const kite = getKiteClient();

  // Instrument token lookup — kiteconnect needs an integer instrument token.
  // We search NSE:SYMBOL token from the instruments list (cached per session).
  const instrumentToken = await resolveInstrumentToken(symbol, exchange);
  if (!instrumentToken) {
    log.warn(`Instrument token not found for ${exchange}:${symbol}`);
    return null;
  }

  const targetDate = typeof date === "string" ? new Date(date) : date;
  // Fetch a small window around the target date to handle weekends/holidays
  const from = format(subDays(targetDate, 3), "yyyy-MM-dd");
  const to = format(targetDate, "yyyy-MM-dd");

  log.debug(`Fetching historical data for ${symbol}`, { from, to });

  try {
    const candles = (await kite.getHistoricalData(
      instrumentToken,
      "day",
      from,
      to
    )) as KiteOHLC[];

    if (!candles || candles.length === 0) {
      log.warn(`No historical data for ${symbol} between ${from} and ${to}`);
      return null;
    }

    // Return the last available candle (closest to target date)
    const last = candles[candles.length - 1];
    log.debug(`Historical price for ${symbol} on ${to}: close=${last.close}`);
    return last;
  } catch (err) {
    log.error(`Failed to fetch historical data for ${symbol}`, {
      error: (err as Error).message,
    });
    throw new Error(
      `Kite getHistoricalData failed for ${symbol}: ${(err as Error).message}`
    );
  }
}

/**
 * Place an order on Kite.
 */
export async function placeKiteOrder(
  params: OrderParams
): Promise<KiteOrderResponse> {
  const kite = getKiteClient();

  const orderPayload = {
    tradingsymbol: params.symbol,
    exchange: params.exchange,
    transaction_type: params.transactionType,
    quantity: params.quantity,
    order_type: params.orderType,
    product: params.product,
    variety: params.variety,
    validity: params.validity,
    ...(params.price !== undefined && { price: params.price }),
    ...(params.triggerPrice !== undefined && { trigger_price: params.triggerPrice }),
  };

  log.info(`Placing ${params.transactionType} order for ${params.symbol}`, {
    quantity: params.quantity,
    orderType: params.orderType,
    product: params.product,
  });

  try {
    const response = (await kite.placeOrder(
      params.variety,
      orderPayload
    )) as KiteOrderResponse;
    log.info(`Order placed successfully`, { orderId: response.order_id });
    return response;
  } catch (err) {
    log.error(`Failed to place order for ${params.symbol}`, {
      error: (err as Error).message,
    });
    throw new Error(
      `Kite placeOrder failed for ${params.symbol}: ${(err as Error).message}`
    );
  }
}

// ─── Instrument Token Cache ───────────────────────────────────────────────────

const _tokenCache: Map<string, number> = new Map();

/**
 * Resolve a symbol to its Kite instrument token (integer).
 * Results are cached in memory for the session.
 */
async function resolveInstrumentToken(
  symbol: string,
  exchange: string
): Promise<number | null> {
  const cacheKey = `${exchange}:${symbol}`;
  if (_tokenCache.has(cacheKey)) return _tokenCache.get(cacheKey)!;

  const kite = getKiteClient();

  try {
    const instruments = await kite.getInstruments([exchange]);
    const match = (instruments as Array<{ tradingsymbol: string; instrument_token: number }>)
      .find((i) => i.tradingsymbol === symbol);

    if (!match) return null;

    _tokenCache.set(cacheKey, match.instrument_token);
    return match.instrument_token;
  } catch (err) {
    log.error("Instrument lookup failed", { error: (err as Error).message });
    return null;
  }
}

/** Clear the instrument token cache (useful between sessions) */
export function clearTokenCache(): void {
  _tokenCache.clear();
}
