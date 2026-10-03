// ─────────────────────────────────────────────────────────────────────────────
//  Yahoo Finance session (cookie + crumb) for quoteSummary endpoints.
//  Unauthenticated quoteSummary requests return 401 as of 2024+.
// ─────────────────────────────────────────────────────────────────────────────

import axios, { type AxiosRequestConfig } from "axios";
import { scopedLogger } from "./logger";

const log = scopedLogger("yahooClient");

export const YAHOO_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const SESSION_TTL_MS = 25 * 60 * 1000;

let session: { cookie: string; crumb: string; expiresAt: number } | null = null;

export function yahooTicker(symbol: string, exchange = "NSE"): string {
  const suffix = exchange === "BSE" ? "BO" : "NS";
  return `${symbol.trim().toUpperCase()}.${suffix}`;
}

async function refreshYahooSession(): Promise<{ cookie: string; crumb: string }> {
  const fc = await axios.get("https://fc.yahoo.com", {
    headers: {
      "User-Agent": YAHOO_USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
    maxRedirects: 5,
    timeout: 12000,
    validateStatus: (status) => status < 500,
  });

  const setCookie = fc.headers["set-cookie"];
  const cookie = Array.isArray(setCookie)
    ? setCookie.map((c) => c.split(";")[0]).join("; ")
    : "";

  const crumbRes = await axios.get("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: {
      "User-Agent": YAHOO_USER_AGENT,
      Cookie: cookie,
      Accept: "text/plain,*/*",
    },
    timeout: 12000,
    validateStatus: (status) => status < 500,
  });

  const crumb =
    typeof crumbRes.data === "string" ? crumbRes.data.trim() : String(crumbRes.data ?? "").trim();

  if (!crumb) {
    throw new Error("Yahoo Finance crumb was empty");
  }

  session = { cookie, crumb, expiresAt: Date.now() + SESSION_TTL_MS };
  log.debug("Yahoo session refreshed");
  return { cookie, crumb };
}

async function getYahooSession(): Promise<{ cookie: string; crumb: string }> {
  if (session && Date.now() < session.expiresAt) {
    return { cookie: session.cookie, crumb: session.crumb };
  }
  return refreshYahooSession();
}

export type QuoteSummaryResult = Record<string, unknown>;

export function normalizeDiscoveredSymbols(symbols: Array<string | null | undefined>): string[] {
  const normalized = symbols
    .filter((symbol): symbol is string => typeof symbol === "string" && symbol.trim().length > 0)
    .map((symbol) => symbol.trim().toUpperCase())
    .map((symbol) => symbol.replace(/\.(NS|BO|NSE|BSE)$/i, ""))
    .filter((symbol) => symbol.length > 0 && !symbol.includes(" ") && !symbol.includes("-"))
    .filter((symbol) => !/^(NIFTY|BANKNIFTY|SENSEX|FINNIFTY|MIDCPNIFTY|ETF|BEES|REIT|INVIT|^\^)/i.test(symbol));

  return Array.from(new Set(normalized));
}

export async function searchYahooSymbols(query: string, limit = 20): Promise<string[]> {
  try {
    const response = await axios.get("https://query1.finance.yahoo.com/v1/finance/search", {
      params: {
        q: query,
        quotesCount: limit,
        newsCount: 0,
        enableFuzzyQuery: false,
      },
      timeout: 15000,
      headers: {
        "User-Agent": YAHOO_USER_AGENT,
        Accept: "application/json",
      },
    });

    const quotes = Array.isArray(response.data?.quotes) ? response.data.quotes : [];
    const symbols = quotes.map((item: any) => item?.symbol).filter(Boolean);
    return normalizeDiscoveredSymbols(symbols);
  } catch (err) {
    log.warn(`Yahoo symbol search failed for query "${query}"`, { error: (err as Error).message });
    return [];
  }
}

export function getFallbackSymbolSeeds(): string[] {
  return [
    "RELIANCE","TCS","INFY","HDFCBANK","ICICIBANK","SBIN","ITC","LT","MARUTI","ASIANPAINT",
    "HINDUNILVR","ULTRACEMCO","JSWSTEEL","TATASTEEL","BAJFINANCE","KOTAKBANK","AXISBANK",
    "ADANIENT","ADANIPORTS","BHARTIARTL","INDUSINDBK","HCLTECH","TECHM","WIPRO","COALINDIA",
    "DABUR","DIVISLAB","DRREDDY","SUNPHARMA","CIPLA","LUPIN","M&M","TITAN","PIDILITIND",
    "APOLLOHOSP","POLYCAB","PAGEIND","TATAMOTORS","BHEL","GAIL","IDEA","PNB","FEDERALBNK",
    "BANKBARODA","CANBK","BANDHANBNK","JINDALSTEL","NMDC","AARTIIND","UPL","GODREJCP",
    "COLPAL","ZYDUSLIFE","AUROPHARMA","BIOCON","IRCTC","DELHIVERY","ZEEL","DMART","BEL",
    "MUTHOOTFIN","SRF","PIIND","VOLTAS","CHOLAFIN","ABCAPITAL","PFC","NHPC","IOC","ONGC",
    "SIEMENS","INDIGO","TVSMOTOR","TRENT","NBCC","HUDCO","KALYANKJIL","BALKRISIND","LTI","MINDTREE"
  ];
}

export async function discoverNseSymbols(limit = 180): Promise<string[]> {
  const queries = [
    "india stocks",
    "nse stocks",
    "bse stocks",
    "top indian companies",
    "mid cap india",
    "small cap india",
    "financial stocks",
    "healthcare stocks",
    "energy stocks",
    "consumer stocks",
    "technology stocks",
    "pharma stocks",
  ];

  const discovered = new Set<string>();

  for (const query of queries) {
    const matches = await searchYahooSymbols(query, 20);
    matches.forEach((symbol) => discovered.add(symbol));
    if (discovered.size >= limit) break;
  }

  if (discovered.size > 0) {
    return Array.from(discovered).slice(0, limit);
  }

  return getFallbackSymbolSeeds().slice(0, limit);
}

/**
 * Fetch one or more quoteSummary modules for a Yahoo ticker (e.g. RELIANCE.NS).
 */
export async function fetchQuoteSummary(
  ticker: string,
  modules: string,
  retryOnAuth = true
): Promise<QuoteSummaryResult | null> {
  const { cookie, crumb } = await getYahooSession();
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}`;

  const config: AxiosRequestConfig = {
    params: { modules, crumb },
    timeout: 12000,
    headers: {
      "User-Agent": YAHOO_USER_AGENT,
      Cookie: cookie,
      Accept: "application/json",
    },
  };

  try {
    const response = await axios.get(url, config);
    const result = response.data?.quoteSummary?.result?.[0];
    return (result as QuoteSummaryResult) ?? null;
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    if (retryOnAuth && (status === 401 || status === 403)) {
      log.debug("Yahoo quoteSummary auth failed; refreshing session", { ticker });
      session = null;
      const retry = await getYahooSession();
      try {
        const response = await axios.get(url, {
          ...config,
          params: { modules, crumb: retry.crumb },
          headers: { ...config.headers, Cookie: retry.cookie },
        });
        const result = response.data?.quoteSummary?.result?.[0];
        return (result as QuoteSummaryResult) ?? null;
      } catch (retryErr) {
        log.warn(`Yahoo quoteSummary failed for ${ticker}`, {
          error: (retryErr as Error).message,
          status: axios.isAxiosError(retryErr) ? retryErr.response?.status : undefined,
        });
        return null;
      }
    }
    log.warn(`Yahoo quoteSummary failed for ${ticker}`, {
      error: (err as Error).message,
      status,
    });
    return null;
  }
}
