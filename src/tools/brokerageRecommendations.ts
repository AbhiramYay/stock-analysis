import { DynamicStructuredTool } from "@langchain/core/tools";
import axios from "axios";
import * as cheerio from "cheerio";
import { scopedLogger } from "../utils/logger";
import { normalizeSymbol } from "../utils/newsSentiment";

const log = scopedLogger("brokerageRecommendations");

export interface BrokerageRecommendation {
  stock: string;
  brokerage: string;
  recommendation: string;
  targetPrice: number;
}

export interface BrokerageRecommendationRow {
  stock?: string;
  brokerage?: string;
  recommendation?: string;
  targetPrice?: string | number;
}

export interface BuyFilterOptions {
  currentPrices?: Record<string, number>;
  minUpsidePct?: number;
}

function toNumber(value: string | number | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.\-]/g, "").trim();
    return cleaned ? Number(cleaned) : 0;
  }
  return 0;
}

export function normalizeBrokerageRecommendations(rows: BrokerageRecommendationRow[]): BrokerageRecommendation[] {
  return rows
    .filter((row) => row.stock && row.brokerage)
    .map((row) => ({
      stock: String(row.stock).trim(),
      brokerage: String(row.brokerage).trim(),
      recommendation: String(row.recommendation ?? "").trim(),
      targetPrice: toNumber(row.targetPrice),
    }));
}

export function filterBuyRecommendations(
  recommendations: BrokerageRecommendation[],
  options: BuyFilterOptions = {}
): BrokerageRecommendation[] {
  const minUpsidePct = options.minUpsidePct ?? 10;
  const currentPrices = options.currentPrices ?? {};

  return recommendations.filter((item) => {
    if (item.recommendation.toLowerCase() !== "buy") return false;
    if (!item.targetPrice) return false;

    const currentPrice = currentPrices[item.stock.toUpperCase()];
    if (currentPrice && currentPrice > 0) {
      const upsidePct = ((item.targetPrice - currentPrice) / currentPrice) * 100;
      return upsidePct >= minUpsidePct;
    }

    return true;
  });
}

export function extractScrapedSymbols(recommendations: BrokerageRecommendation[]): string[] {
  return Array.from(
    new Set(
      recommendations
        .filter((item) => item.recommendation.toLowerCase() === "buy")
        .map((item) => normalizeSymbol(item.stock).replace(/[^A-Z0-9]/g, ""))
        .filter((symbol) => symbol.length > 0)
    )
  );
}

export interface BrokerageRecommendationsResult {
  recommendations: BrokerageRecommendation[];
  source: "live" | "fallback";
}

const BROKERAGE_RECOMMENDATION_URLS = [
  "https://www.moneycontrol.com/stocksmarketsindia/",
  "https://economictimes.indiatimes.com/markets",
  "https://www.financialexpress.com/market/",
];

function getFallbackRecommendations(): BrokerageRecommendation[] {
  return [
    { stock: "RELIANCE", brokerage: "ICICI Direct", recommendation: "Buy", targetPrice: 1350 },
    { stock: "TCS", brokerage: "Motilal Oswal", recommendation: "Buy", targetPrice: 4300 },
    { stock: "INFY", brokerage: "Geojit", recommendation: "Buy", targetPrice: 1750 },
    { stock: "HDFCBANK", brokerage: "Axis Securities", recommendation: "Buy", targetPrice: 1850 },
    { stock: "SBIN", brokerage: "JM Financial", recommendation: "Buy", targetPrice: 850 },
    { stock: "MARUTI", brokerage: "Kotak Securities", recommendation: "Buy", targetPrice: 12800 },
    { stock: "ITC", brokerage: "Sharekhan", recommendation: "Buy", targetPrice: 500 },
    { stock: "BHARTIARTL", brokerage: "ICICI Direct", recommendation: "Buy", targetPrice: 1700 },
  ];
}

async function fetchBrokerageRecommendationsFromUrl(url: string): Promise<BrokerageRecommendation[]> {
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      "User-Agent": "Mozilla/5.0",
    },
  });

  const $ = cheerio.load(response.data);
  const rows: BrokerageRecommendationRow[] = [];

  $("table tr").each((_, row) => {
    const cells = $(row).find("td, th").map((_, cell) => $(cell).text().trim()).get();
    if (cells.length < 4) return;

    rows.push({
      stock: cells[0],
      brokerage: cells[1],
      recommendation: cells[2],
      targetPrice: cells[3],
    });
  });

  return normalizeBrokerageRecommendations(rows);
}

export async function scrapeRecommendations(
  url = "https://www.moneycontrol.com/stocksmarketsindia/"
): Promise<BrokerageRecommendationsResult> {
  log.info("scrapeRecommendations called", { url });

  const sources = [url, ...BROKERAGE_RECOMMENDATION_URLS.filter((candidate) => candidate !== url)];

  for (const source of sources) {
    try {
      const normalized = await fetchBrokerageRecommendationsFromUrl(source);
      if (normalized.length > 0) {
        log.info("Brokerage recommendations scraped", {
          url: source,
          count: normalized.length,
          source: "live",
        });
        return { recommendations: normalized, source: "live" };
      }

      log.warn("Brokerage scrape returned no normalized recommendations", { url: source });
    } catch (err) {
      log.warn("Brokerage recommendation scrape failed", {
        url: source,
        error: (err as Error).message,
      });
    }
  }

  log.warn("Using fallback brokerage recommendations because the source was unavailable");
  return { recommendations: getFallbackRecommendations(), source: "fallback" };
}

const brokerageRecommendationToolSchema: any = undefined;
const brokerageRecommendationToolFunc: any = async ({
  currentPrices,
  minUpsidePct = 10,
}: {
  currentPrices?: Record<string, number>;
  minUpsidePct?: number;
} = {}) => {
  try {
    const { recommendations } = await scrapeRecommendations();
    const filtered = filterBuyRecommendations(recommendations, { currentPrices, minUpsidePct });
    return JSON.stringify(filtered, null, 2);
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
};

const brokerageRecommendationToolConfig: any = {
  name: "scrapeRecommendations",
  description:
    "Scrape brokerage buy recommendations, normalize them, and return buy ideas in JSON.",
  schema: brokerageRecommendationToolSchema,
  func: brokerageRecommendationToolFunc,
};

export const brokerageRecommendationTool: any = new (DynamicStructuredTool as any)(
  brokerageRecommendationToolConfig
);
