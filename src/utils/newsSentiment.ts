import axios from "axios";
import { scopedLogger } from "./logger";
import type { EnhancedSentimentResult, SentimentLabel } from "../types/index";
import { analyzeSentimentWithLLM, convertKeywordSentiment } from "./llmSentiment";
import { fetchYahooFundamentals } from "./yahooFundamentals";

const log = scopedLogger("newsSentiment");

export const POSITIVE_WORDS = [
  "beat",
  "beats",
  "upgrade",
  "upgraded",
  "strong",
  "buoyant",
  "gain",
  "gains",
  "rally",
  "profit",
  "profits",
  "growth",
  "optimistic",
  "outperform",
  "outperforms",
  "record",
  "surge",
  "upside",
  "positive",
  "bullish",
  "rebound",
  "buy",
  "accumulate",
  "overweight",
  "target raised",
  "raises target",
];

export const NEGATIVE_WORDS = [
  "miss",
  "misses",
  "downgrade",
  "downgraded",
  "weak",
  "fall",
  "falls",
  "loss",
  "losses",
  "cut",
  "cuts",
  "sell",
  "selloff",
  "decline",
  "declines",
  "concern",
  "concerns",
  "probe",
  "issue",
  "issues",
  "slowdown",
  "warning",
  "negative",
  "bearish",
  "risk",
  "risks",
  "volatile",
  "volatility",
  "uncertain",
  "underperform",
  "underweight",
  "target cut",
  "cuts target",
];

const YAHOO_RSS = (symbol: string) =>
  `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=IN&lang=en-IN`;
const GOOGLE_RSS = (symbol: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(symbol + " stock india NSE")}&hl=en-IN&gl=IN&ceid=IN:en`;
const GOOGLE_ANALYST_RSS = (symbol: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(symbol + " analyst recommendation brokerage india")}&hl=en-IN&gl=IN&ceid=IN:en`;

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ",).trim();
}

function parseRssItems(xml: string): Array<{ title: string; snippet?: string }> {
  const items: Array<{ title: string; snippet?: string }> = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const titleMatch = /<title>(.*?)<\/title>/i.exec(itemXml);
    const descMatch = /<description>(.*?)<\/description>/i.exec(itemXml);
    const title = titleMatch?.[1]?.trim() ?? "";
    const snippet = descMatch?.[1]
      ? stripHtml(descMatch[1].trim())
      : undefined;

    if (title && !title.toLowerCase().includes("yahoo finance") && !title.toLowerCase().includes("google news")) {
      items.push({ title, snippet });
    }
  }

  return items;
}

function extractAnalystNote(headlines: string[]): string {
  const analystPatterns = /\b(upgrade|downgrade|buy|sell|outperform|underperform|accumulate|overweight|underweight|target raised|target cut|brokerage|analyst)\b/i;
  const analystHeadlines = headlines.filter((headline) => analystPatterns.test(headline));
  return analystHeadlines.slice(0, 3).join(" | ");
}

async function buildEarningsExcerpt(symbol: string, exchange = "NSE"): Promise<string> {
  try {
    const fundamentals = await fetchYahooFundamentals(symbol, exchange);
    const facts: string[] = [];
    if (fundamentals.earningsGrowth !== null) {
      facts.push(`earnings growth ${fundamentals.earningsGrowth.toFixed(1)}%`);
    }
    if (fundamentals.peRatio !== null) {
      facts.push(`forward P/E ${fundamentals.peRatio.toFixed(1)}`);
    }
    if (fundamentals.debtToEquity !== null) {
      facts.push(`debt/equity ${fundamentals.debtToEquity.toFixed(2)}`);
    }
    if (fundamentals.roe !== null) {
      facts.push(`return on equity ${fundamentals.roe.toFixed(1)}%`);
    }

    if (facts.length === 0) {
      return "";
    }

    return `Earnings excerpt: ${facts.join("; ")}.`;
  } catch (err) {
    log.warn(`Failed to build earnings excerpt for ${symbol}`, {
      error: (err as Error).message,
    });
    return "";
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function scoreHeadlineSentiment(title: string): number {
  const lower = title.toLowerCase();
  const tokens = tokenize(title);
  let score = 0;
  for (const token of tokens) {
    if (POSITIVE_WORDS.includes(token)) score += 1;
    if (NEGATIVE_WORDS.includes(token)) score -= 1;
  }
  if (lower.includes("target raised") || lower.includes("raises target")) score += 2;
  if (lower.includes("target cut") || lower.includes("cuts target")) score -= 2;
  if (/\b(buy|accumulate|overweight)\b/i.test(lower)) score += 1;
  if (/\b(sell|underperform|underweight)\b/i.test(lower)) score -= 1;
  return score;
}

export function classifySentiment(headlines: string[]): {
  score: number;
  label: SentimentLabel;
  reasoning: string;
  analystSignals: string[];
} {
  const analystSignals: string[] = [];

  for (const headline of headlines) {
    const lower = headline.toLowerCase();
    if (/\b(upgrade|buy|outperform|accumulate|overweight|target raised)\b/i.test(lower)) {
      analystSignals.push(headline);
    }
    if (/\b(downgrade|sell|underperform|underweight|target cut)\b/i.test(lower)) {
      analystSignals.push(headline);
    }
  }

  if (headlines.length === 0) {
    return {
      score: 0,
      label: "neutral",
      reasoning: "No recent headlines from Yahoo Finance or Google News RSS feeds.",
      analystSignals: [],
    };
  }

  const scores = headlines.map((headline) => scoreHeadlineSentiment(headline));
  const total = scores.reduce((sum, value) => sum + value, 0);
  const average = total / headlines.length;

  const positiveCount = scores.filter((value) => value > 0).length;
  const negativeCount = scores.filter((value) => value < 0).length;
  const neutralCount = scores.filter((value) => value === 0).length;

  const label: SentimentLabel =
    average >= 0.25 ? "positive" : average <= -0.25 ? "negative" : "neutral";

  const reasoning =
    `Analysed ${headlines.length} headlines (${positiveCount} positive, ${negativeCount} negative, ${neutralCount} neutral). ` +
    `News & analyst tone is ${label} (avg score ${average.toFixed(2)}).`;

  return {
    score: label === "positive" ? 1 : label === "negative" ? -1 : 0,
    label,
    reasoning,
    analystSignals: analystSignals.slice(0, 4),
  };
}

function parseRssTitles(xml: string): string[] {
  const titles: string[] = [];
  const titleRegex = /<title>(.*?)<\/title>/gi;
  let match: RegExpExecArray | null;

  while ((match = titleRegex.exec(xml)) !== null) {
    const title = match[1].trim();
    if (
      title &&
      !title.toLowerCase().includes("yahoo finance") &&
      !title.toLowerCase().includes("google news")
    ) {
      titles.push(title);
    }
  }

  return titles;
}

export async function fetchNewsHeadlines(symbol: string): Promise<string[]> {
  const normalized = normalizeSymbol(symbol);
  const yahooSymbol = normalized.includes("-") ? normalized : `${normalized}.NS`;
  const sources = [
    { url: YAHOO_RSS(yahooSymbol) },
    { url: GOOGLE_RSS(normalized) },
    { url: GOOGLE_ANALYST_RSS(normalized) },
  ];
  const headlines = new Set<string>();

  for (const source of sources) {
    try {
      const response = await axios.get<string>(source.url, {
        timeout: 9000,
        headers: { Accept: "application/rss+xml, application/xml, text/xml" },
      });
      parseRssItems(response.data)
        .slice(0, 6)
        .forEach((item) => {
          const text = item.snippet
            ? `${item.title} — ${item.snippet}`
            : item.title;
          headlines.add(text);
        });
    } catch (err) {
      log.warn(`News source failed for ${symbol}`, { url: source.url, error: (err as Error).message });
    }
  }

  return Array.from(headlines).slice(0, 8);
}

export async function analyzeSentimentHybrid(
  headlines: string[],
  symbol: string
): Promise<EnhancedSentimentResult> {
  if (headlines.length === 0) {
    return convertKeywordSentiment(classifySentiment(headlines));
  }

  const analystNote = extractAnalystNote(headlines);
  const earningsExcerpt = await buildEarningsExcerpt(symbol);

  try {
    return await analyzeSentimentWithLLM(headlines, symbol, analystNote, earningsExcerpt);
  } catch (err) {
    log.warn(`LLM sentiment failed for ${symbol}, falling back to keyword sentiment`, {
      error: (err as Error).message,
    });
    return convertKeywordSentiment(classifySentiment(headlines));
  }
}
