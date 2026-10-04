// ─────────────────────────────────────────────────────────────────────────────
//  src/utils/kiteClient.ts
//  Zerodha Kite API client using enctoken (Kite web login session token)
//
//  How to get your enctoken:
//   1. Log in at https://kite.zerodha.com
//   2. Open DevTools → Application → Cookies → kite.zerodha.com
//   3. Copy the value of the "enctoken" cookie
//   4. Paste it as KITE_ENCTOKEN in your .env file
//
//  The enctoken is valid for the current browser session (resets at 6 AM IST).
//  No API key or API secret is required.
// ─────────────────────────────────────────────────────────────────────────────

import axios, { AxiosInstance, AxiosError } from "axios";
import { addDays, format, subDays } from "date-fns";
import type {
  KiteHolding,
  KiteOHLC,
  KiteOrderResponse,
  OrderParams,
} from "../types/index";
import { scopedLogger } from "./logger";
import { discoverNseSymbols, fetchQuoteSummary, YAHOO_USER_AGENT, yahooTicker } from "./yahooClient";

const log = scopedLogger("KiteClient");

// ─── Constants ────────────────────────────────────────────────────────────────

const KITE_BASE_URL = "https://kite.zerodha.com/oms";

// Kite's web OMS rate limit: ~3 req/sec sustained.
// We throttle to 1 req per 400ms to stay safely under it.
const REQUEST_INTERVAL_MS = 400;

// Retry settings for 429 / transient errors
const MAX_RETRIES     = 3;
const RETRY_BASE_MS   = 1500; // exponential backoff: 1.5s, 3s, 6s

// ─── Axios Client Singleton ───────────────────────────────────────────────────

let _axiosClient: AxiosInstance | null = null;
const yahooSectorCache = new Map<string, string | undefined>();

/**
 * Returns a lazily-initialized Axios instance authenticated with enctoken.
 * All Kite API requests use:
 *   Authorization: enctoken <KITE_ENCTOKEN>
 */
export function getKiteClient(): AxiosInstance {
  if (_axiosClient) return _axiosClient;

  const enctoken = process.env.KITE_ENCTOKEN;

  if (!enctoken) {
    throw new Error(
      "KITE_ENCTOKEN is not set.\n" +
      "  1. Log in at https://kite.zerodha.com\n" +
      "  2. Open DevTools → Application → Cookies → kite.zerodha.com\n" +
      "  3. Copy the 'enctoken' cookie value and paste it into .env as KITE_ENCTOKEN=<value>\n" +
      "  Or run:  npm run auth  for step-by-step guidance."
    );
  }

  _axiosClient = axios.create({
    baseURL: KITE_BASE_URL,
    headers: {
      "Authorization": `enctoken ${enctoken}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Kite-Version": "3",
    },
  });

  // Response interceptor: unwrap Kite's { status, data } envelope
  _axiosClient.interceptors.response.use(
    (res) => {
      if (res.data?.status === "error") {
        throw new Error(`Kite API error: ${res.data.message ?? JSON.stringify(res.data)}`);
      }
      return res;
    },
    (err: AxiosError) => {
      const data = err.response?.data as Record<string, unknown> | undefined;
      const msg  = (data?.message as string) ?? err.message;
      if (err.response?.status === 403) {
        throw new Error(
          `Kite auth failed (403): enctoken may be expired or invalid.\n` +
          `  Re-run 'npm run auth' to copy a fresh token from your browser.\n` +
          `  Original: ${msg}`
        );
      }
      throw new Error(
        `Kite API request failed [${err.response?.status ?? "network"}]: ${msg}`
      );
    }
  );

  log.debug("Kite client initialized");

  return _axiosClient;
}

/** Reset the client (useful after updating the enctoken at runtime) */
export function resetKiteClient(): void {
  _axiosClient = null;
  _tokenCache.clear();
  _exchangeInstruments.clear();
  _instrumentFetchPromise.clear();
  log.debug("Kite client reset");
}

// ─── Rate-limited request helper ─────────────────────────────────────────────

let _lastRequestAt = 0;

/**
 * Throttled GET with automatic exponential-backoff retry on 429.
 * Ensures at least REQUEST_INTERVAL_MS between consecutive requests.
 */
async function throttledGet<T>(
  url: string,
  params?: Record<string, unknown>
): Promise<T> {
  const client = getKiteClient();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Throttle: wait until the minimum interval has elapsed
    const elapsed = Date.now() - _lastRequestAt;
    if (elapsed < REQUEST_INTERVAL_MS) {
      await sleep(REQUEST_INTERVAL_MS - elapsed);
    }
    _lastRequestAt = Date.now();

    try {
      const res = await client.get<T>(url, params ? { params } : undefined);
      return res.data;
    } catch (err) {
      const msg = (err as Error).message;
      const is429 = msg.includes("429") || msg.includes("Too many");

      if (is429 && attempt < MAX_RETRIES) {
        const backoff = RETRY_BASE_MS * Math.pow(2, attempt);
        log.warn(`Rate limited (429) on ${url} — retrying in ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`throttledGet: exceeded ${MAX_RETRIES} retries for ${url}`);
}

// ─── API Wrappers ─────────────────────────────────────────────────────────────

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

async function fetchHistoricalPricesViaYahoo(
  symbol: string,
  fromDate: Date | string,
  toDate: Date | string,
  exchange = "NSE"
): Promise<KiteOHLC[]> {
  const ticker = yahooTicker(symbol, exchange);
  const fromTs = Math.floor(new Date(fromDate).getTime() / 1000);
  const toTs = Math.floor(addDays(new Date(toDate), 1).getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`;

  try {
    const response = await axios.get(url, {
      params: {
        period1: fromTs,
        period2: toTs,
        interval: "1d",
        events: "div,splits",
      },
      timeout: 12000,
      headers: {
        "User-Agent": YAHOO_USER_AGENT,
      },
    });

    const data = response.data;
    const result = data?.chart?.result?.[0];
    if (!result || !Array.isArray(result.timestamp)) return [];

    const quote = result.indicators?.quote?.[0];
    if (!quote) return [];

    const candles: KiteOHLC[] = result.timestamp
      .map((ts: number, idx: number): KiteOHLC => ({
        date: new Date(ts * 1000),
        open: quote.open[idx],
        high: quote.high[idx],
        low: quote.low[idx],
        close: quote.close[idx],
        volume: quote.volume[idx],
      }))
      .filter((c: KiteOHLC) => c.open !== null && c.high !== null && c.low !== null && c.close !== null);

    return candles;
  } catch (err) {
    log.warn(`Yahoo fallback failed for ${symbol} (${ticker})`, {
      error: (err as Error).message,
    });
    return [];
  }
}

function yahooSectorCacheKey(symbol: string, exchange: string) {
  return `${normalizeSymbol(symbol)}:${exchange}`;
}

export async function fetchYahooSector(
  symbol: string,
  exchange = "NSE"
): Promise<string | undefined> {
  const cacheKey = yahooSectorCacheKey(symbol, exchange);
  if (yahooSectorCache.has(cacheKey)) return yahooSectorCache.get(cacheKey);

  const ticker = yahooTicker(symbol, exchange);

  try {
    const result = await fetchQuoteSummary(ticker, "assetProfile");
    const profile = result?.assetProfile as { sector?: string } | undefined;
    const sector = profile?.sector;
    if (typeof sector === "string" && sector.trim().length > 0) {
      yahooSectorCache.set(cacheKey, sector);
      return sector;
    }

    // JSON lookup didn't yield sector — try HTML profile page
    try {
      const profileUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/profile`;
      const htmlRes = await axios.get(profileUrl, {
        timeout: 12000,
        headers: { "User-Agent": YAHOO_USER_AGENT },
      });
      const html = htmlRes.data as string;
      const match = html.match(/Sector\s*<\/span>\s*<span[^>]*>([^<]+)<\/span>/i) || html.match(/Sector\(s\):\s*<span[^>]*>([^<]+)<\/span>/i);
      const sectorFromHtml = match ? match[1].trim() : undefined;
      if (sectorFromHtml) {
        yahooSectorCache.set(cacheKey, sectorFromHtml);
        return sectorFromHtml;
      }
    } catch (htmlErr) {
      log.debug(`Yahoo HTML profile fallback failed for ${symbol} (${ticker})`, { error: (htmlErr as Error).message });
    }

    yahooSectorCache.set(cacheKey, undefined);
    return undefined;
  } catch (err) {
    log.warn(`Yahoo sector lookup failed for ${symbol} (${ticker})`, { error: (err as Error).message });
    yahooSectorCache.set(cacheKey, undefined);
    return undefined;
  }
}

/**
 * Fetch all current equity holdings.
 */
export async function fetchNseEquitySymbols(limit = 200): Promise<string[]> {
  return discoverNseSymbols(limit);
}

export async function fetchHoldings(): Promise<KiteHolding[]> {
  log.debug("Fetching holdings from Kite");

  try {
    const data = await throttledGet<{ status: string; data: KiteHolding[] }>(
      "/portfolio/holdings"
    );
    const holdings = data.data ?? [];
    log.debug(`Fetched ${holdings.length} holdings from Kite`);
    return holdings;
  } catch (err) {
    log.error("Failed to fetch holdings", { error: (err as Error).message });
    throw new Error(`fetchHoldings failed: ${(err as Error).message}`);
  }
}

/**
 * Fetch historical OHLCV data for a symbol on a specific date.
 * Falls back to the nearest prior trading day for weekends/holidays.
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
  const targetDate = typeof date === "string" ? new Date(date) : date;
  const fromDate = subDays(targetDate, 3);
  const toDate = targetDate;

  // Prefer Yahoo first — quicker and doesn't require instrument token.
  try {
    const yahooCandles = await fetchHistoricalPricesViaYahoo(symbol, fromDate, toDate, exchange);
    if (yahooCandles.length > 0) {
      const last = yahooCandles[yahooCandles.length - 1];
      log.debug(
        `Historical price for ${symbol} (Yahoo): close=${last.close} (${format(last.date, "yyyy-MM-dd")})`
      );
      return last;
    }
  } catch (err) {
    log.warn(`Yahoo lookup failed for ${symbol}, will try Kite`, { error: (err as Error).message });
  }

  // Yahoo returned no data — fall back to Kite path
  const instrumentToken = await resolveInstrumentToken(symbol, exchange);

  if (!instrumentToken) {
    log.warn(`Instrument token not found for ${exchange}:${symbol}, and Yahoo returned no data`);
    return null;
  }

  const from = format(fromDate, "yyyy-MM-dd");
  const to = format(toDate, "yyyy-MM-dd");

  log.debug(`Fetching historical data for ${symbol} via Kite`, { from, to });

  try {
    const data = await throttledGet<{ status: string; data: RawCandle[] }>(
      `/instruments/historical/${instrumentToken}/day`,
      { from, to, oi: 0 }
    );

    const candles = (data.data ?? []).map(normaliseCandle);

    if (candles.length === 0) {
      log.warn(`No historical data for ${symbol} between ${from} and ${to} (Kite)`);
      return null;
    }

    const last = candles[candles.length - 1];
    log.debug(
      `Historical price for ${symbol} (Kite): close=${last.close} (${format(last.date, "yyyy-MM-dd")})`
    );
    return last;
  } catch (err) {
    log.warn(`Kite failed to fetch historical data for ${symbol} and Yahoo returned no data`, {
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Fetch historical OHLCV data for a symbol across a date range.
 * Returns all available daily candles between fromDate and toDate.
 */
export async function fetchHistoricalPrices(
  symbol: string,
  fromDate: Date | string,
  toDate: Date | string,
  exchange = "NSE"
): Promise<KiteOHLC[]> {
  const from = typeof fromDate === "string" ? fromDate : format(fromDate, "yyyy-MM-dd");
  const to = typeof toDate === "string" ? toDate : format(toDate, "yyyy-MM-dd");

  log.debug(`Fetching historical range for ${symbol}`, { from, to });

  // Try Yahoo first — faster and doesn't require instrument token
  try {
    const yahooCandles = await fetchHistoricalPricesViaYahoo(symbol, fromDate, toDate, exchange);
    if (yahooCandles.length > 0) {
      return yahooCandles.sort((a, b) => a.date.getTime() - b.date.getTime());
    }
  } catch (err) {
    log.warn(`Yahoo historical range lookup failed for ${symbol}, will try Kite`, { error: (err as Error).message });
  }

  // Yahoo returned no data — fall back to Kite
  const instrumentToken = await resolveInstrumentToken(symbol, exchange);

  if (!instrumentToken) {
    log.warn(`Instrument token not found for ${exchange}:${symbol}, and Yahoo returned no data`);
    return [];
  }

  try {
    const data = await throttledGet<{ status: string; data: RawCandle[] }>(
      `/instruments/historical/${instrumentToken}/day`,
      { from, to, oi: 0 }
    );

    const candles = (data.data ?? []).map(normaliseCandle);
    return candles.sort((a, b) => a.date.getTime() - b.date.getTime());
  } catch (err) {
    log.warn(`Failed to fetch historical range for ${symbol} via Kite, and Yahoo returned no data`, {
      error: (err as Error).message,
    });
    return [];
  }
}

/**
 * Place an equity order via Kite.
 */
export async function placeKiteOrder(params: OrderParams): Promise<KiteOrderResponse> {
  const client = getKiteClient();

  const body = new URLSearchParams({
    tradingsymbol:    params.symbol,
    exchange:         params.exchange,
    transaction_type: params.transactionType,
    quantity:         String(params.quantity),
    order_type:       params.orderType,
    product:          params.product,
    validity:         params.validity,
    ...(params.price !== undefined        && { price:         String(params.price) }),
    ...(params.triggerPrice !== undefined && { trigger_price: String(params.triggerPrice) }),
  });

  log.debug(`Placing ${params.transactionType} order`, {
    symbol:    params.symbol,
    quantity:  params.quantity,
    orderType: params.orderType,
    product:   params.product,
  });

  // Throttle + retry for order placement too
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const elapsed = Date.now() - _lastRequestAt;
    if (elapsed < REQUEST_INTERVAL_MS) await sleep(REQUEST_INTERVAL_MS - elapsed);
    _lastRequestAt = Date.now();

    try {
      const res = await client.post<{ status: string; data: { order_id: string } }>(
        `/orders/${params.variety}`,
        body.toString()
      );
      const orderId = res.data.data.order_id;
      log.debug("Order placed", { orderId });
      return { order_id: orderId };
    } catch (err) {
      const msg   = (err as Error).message;
      const is429 = msg.includes("429") || msg.includes("Too many");
      if (is429 && attempt < MAX_RETRIES) {
        const backoff = RETRY_BASE_MS * Math.pow(2, attempt);
        log.warn(`Rate limited placing order — retrying in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
      log.error(`Failed to place order for ${params.symbol}`, { error: msg });
      throw new Error(`placeKiteOrder failed for ${params.symbol}: ${msg}`);
    }
  }

  throw new Error(`placeKiteOrder: exceeded retries for ${params.symbol}`);
}

// ─── Instrument Token Cache ───────────────────────────────────────────────────
//
//  TWO-LEVEL CACHE to eliminate redundant instruments-list fetches:
//
//  Level 1 — _exchangeInstruments: Map<exchange, Map<symbol, token>>
//    The full instruments list per exchange is fetched ONCE and all tokens
//    are stored here. Subsequent lookups for any symbol on that exchange
//    hit this cache directly without any HTTP request.
//
//  Level 2 — _instrumentFetchPromise: Map<exchange, Promise>
//    A deduplication lock: if multiple concurrent calls need the same
//    exchange's instruments list, only ONE HTTP request is made. All other
//    callers await the same in-flight promise instead of firing their own.
//
//  Result: N concurrent PnL calculations → exactly 1 instruments request.

const _tokenCache: Map<string, number>            = new Map(); // legacy per-symbol cache
const _exchangeInstruments: Map<string, Map<string, number>> = new Map();
const _instrumentFetchPromise: Map<string, Promise<void>>    = new Map();

/** Raw instrument row from the Kite instruments API */
interface RawInstrument {
  instrument_token: number;
  tradingsymbol:    string;
  exchange:         string;
}

/**
 * Warm the instruments cache for an exchange.
 * Fetches the full list ONCE and populates _exchangeInstruments.
 * Concurrent callers share the same in-flight promise (no duplicate fetches).
 */
async function warmInstrumentCache(exchange: string): Promise<void> {
  // Already loaded?
  if (_exchangeInstruments.has(exchange)) return;

  // Already in-flight? Await the same promise.
  if (_instrumentFetchPromise.has(exchange)) {
    return _instrumentFetchPromise.get(exchange)!;
  }

  // First caller — start the fetch and store the promise so others can share it
  const fetchPromise = (async () => {
    log.debug(`Loading instruments list for ${exchange}`);

    let rawData: unknown;
    const exchangePath = `/instruments/${exchange.toLowerCase()}`;

    try {
      rawData = await throttledGet<unknown>(exchangePath);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("[404]") || msg.includes("Route not found")) {
        log.warn(`Instruments endpoint ${exchangePath} failed, falling back to public instruments feed`);
        const client = getKiteClient();
        const publicExchangeUrl = `https://kite.zerodha.com/instruments/${exchange.toUpperCase()}`;

        try {
          const response = await client.get<string>(publicExchangeUrl, {
            headers: client.defaults.headers.common,
            responseType: "text",
          });
          rawData = response.data;
        } catch (publicErr) {
          log.warn(
            `Public instruments endpoint ${publicExchangeUrl} failed, falling back to https://kite.zerodha.com/instruments`,
            { error: (publicErr as Error).message }
          );
          const fallbackUrl = "https://kite.zerodha.com/instruments";
          try {
            const fallbackResponse = await client.get<string>(fallbackUrl, {
              headers: client.defaults.headers.common,
              responseType: "text",
            });
            rawData = fallbackResponse.data;
          } catch (fallbackErr) {
            log.warn(
              `Fallback instruments endpoint ${fallbackUrl} failed too. Continuing with empty instrument cache.`,
              { error: (fallbackErr as Error).message }
            );
            rawData = [];
          }
        }
      } else {
        throw err;
      }
    }

    const instruments = parseInstrumentList(rawData, exchange);
    const symbolMap = new Map<string, number>();

    for (const inst of instruments) {
      symbolMap.set(inst.tradingsymbol, inst.instrument_token);
    }

    _exchangeInstruments.set(exchange, symbolMap);
    log.debug(`Instruments cache populated for ${exchange}`, {
      count: symbolMap.size,
    });
  })();

  _instrumentFetchPromise.set(exchange, fetchPromise);

  try {
    await fetchPromise;
  } finally {
    // Keep the promise in the map so late arrivals still share it,
    // but clear it after a short window so errors don't permanently block
    setTimeout(() => _instrumentFetchPromise.delete(exchange), 5000);
  }
}

/**
 * Resolve a trading symbol to its Kite integer instrument token.
 * Uses the two-level cache — at most ONE HTTP request per exchange per session.
 */
async function resolveInstrumentToken(
  symbol: string,
  exchange: string
): Promise<number | null> {
  // Check legacy per-symbol cache first (populated by older code paths)
  const legacyKey = `${exchange}:${symbol}`;
  if (_tokenCache.has(legacyKey)) return _tokenCache.get(legacyKey)!;

  // Warm the full exchange cache if needed (deduplicated)
  await warmInstrumentCache(exchange);

  const symbolMap = _exchangeInstruments.get(exchange);
  if (!symbolMap) return null;

  const token = symbolMap.get(symbol) ?? null;

  if (token === null) {
    log.warn(
      `Symbol "${symbol}" not found in ${exchange} instruments list. ` +
      `It may be delisted, use a different exchange (BSE?), or the symbol ` +
      `may have changed (e.g. SME suffix, -BE, -BL variants). Skipping.`
    );
    return null;
  }

  // Also populate legacy cache for compatibility
  _tokenCache.set(legacyKey, token);
  log.debug(`Resolved ${exchange}:${symbol} → token ${token}`);
  return token;
}

/** Clear all caches (useful when resetting the client) */
export function clearTokenCache(): void {
  _tokenCache.clear();
  _exchangeInstruments.clear();
  _instrumentFetchPromise.clear();
}

function parseInstrumentList(raw: unknown, exchange: string): RawInstrument[] {
  if (typeof raw === "string") {
    return parseInstrumentCsv(raw).filter((inst) => inst.exchange === exchange);
  }

  if (Array.isArray(raw)) {
    return raw as RawInstrument[];
  }

  if (raw && typeof raw === "object" && Array.isArray((raw as any).data)) {
    return (raw as any).data as RawInstrument[];
  }

  return [];
}

function parseInstrumentCsv(csv: string): RawInstrument[] {
  const lines = csv.trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]);
  const tokenIdx = headers.indexOf("instrument_token");
  const symbolIdx = headers.indexOf("tradingsymbol");
  const exchangeIdx = headers.indexOf("exchange");

  if (tokenIdx === -1 || symbolIdx === -1 || exchangeIdx === -1) return [];

  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    return {
      instrument_token: Number(cols[tokenIdx] ?? 0),
      tradingsymbol: String(cols[symbolIdx] ?? ""),
      exchange: String(cols[exchangeIdx] ?? ""),
    };
  });
}

function splitCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Kite historical data returns arrays: [datetime, open, high, low, close, volume] */
type RawCandle = [string, number, number, number, number, number];

function normaliseCandle(raw: RawCandle): KiteOHLC {
  return {
    date:   new Date(raw[0]),
    open:   raw[1],
    high:   raw[2],
    low:    raw[3],
    close:  raw[4],
    volume: raw[5],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
