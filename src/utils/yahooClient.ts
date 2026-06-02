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
  log.debug("Yahoo session refreshed", { crumbLength: crumb.length });
  return { cookie, crumb };
}

async function getYahooSession(): Promise<{ cookie: string; crumb: string }> {
  if (session && Date.now() < session.expiresAt) {
    return { cookie: session.cookie, crumb: session.crumb };
  }
  return refreshYahooSession();
}

export type QuoteSummaryResult = Record<string, unknown>;

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
      log.debug("Yahoo quoteSummary auth failed, refreshing session", { ticker, status });
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
