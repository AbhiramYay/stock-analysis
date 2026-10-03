import { HumanMessage } from "@langchain/core/messages";
import { promises as fs } from "fs";
import * as path from "path";
import { scopedLogger } from "./logger";
import { createLLM } from "./llmFactory";
import type { EnhancedSentimentResult } from "../types/index";

const log = scopedLogger("llmSentiment");

const llmCache = new Map<string, { result: EnhancedSentimentResult; expiresAt: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const LLM_OUTPUT_DIR = path.resolve(process.cwd(), "llm-output");
const DEFAULT_LLM_BATCH_SIZE = 8;

function makeCacheKey(
  symbol: string,
  headlines: string[],
  analystNote: string,
  earningsExcerpt: string
): string {
  return `${symbol}:${headlines.join("||")}:${analystNote}:${earningsExcerpt}`;
}

async function ensureLlmOutputDir(): Promise<void> {
  try {
    await fs.mkdir(LLM_OUTPUT_DIR, { recursive: true });
  } catch {
    // ignore filesystem errors for debug log creation
  }
}

async function dumpLlmOutputFile(filename: string, data: unknown): Promise<void> {
  try {
    await ensureLlmOutputDir();
    const filePath = path.join(LLM_OUTPUT_DIR, filename);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
    log.info("Wrote LLM debug output", { filePath });
  } catch (err) {
    log.warn("Failed to write LLM debug output", { error: (err as Error).message });
  }
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function getBatchSizeForItems(itemCount: number): number {
  const configured = Number.parseInt(process.env.LLM_BATCH_SIZE ?? "", 10);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(configured, itemCount);
  }
  return Math.min(DEFAULT_LLM_BATCH_SIZE, itemCount);
}

function stripCodeFences(text: string): string {
  return text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "");
}

function findJsonText(text: string): string | null {
  const cleanedText = stripCodeFences(text);

  const tryFind = (openChar: string, closeChar: string): string | null => {
    let start = cleanedText.indexOf(openChar);
    while (start !== -1) {
      let inString = false;
      let escape = false;
      let depth = 0;
      for (let i = start; i < cleanedText.length; i++) {
        const ch = cleanedText[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (ch === openChar) {
          depth += 1;
        } else if (ch === closeChar) {
          depth -= 1;
          if (depth === 0) {
            return cleanedText.slice(start, i + 1);
          }
        }
      }
      start = cleanedText.indexOf(openChar, start + 1);
    }
    return null;
  };

  const objectText = tryFind("{", "}");
  if (objectText) return objectText;

  const arrayText = tryFind("[", "]");
  if (arrayText) return arrayText;

  const firstBrace = cleanedText.indexOf("{");
  const lastBrace = cleanedText.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return cleanedText.slice(firstBrace, lastBrace + 1);
  }

  return null;
}

function sanitizeJsonText(jsonText: string): string {
  let cleaned = jsonText
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  cleaned = cleaned.replace(/([\{,])\s*([^\"\s][^:\n\r]+?)\s*:/g, '$1"$2":');
  cleaned = cleaned.replace(/:\s*'([^']*)'/g, ': "$1"');
  cleaned = cleaned.replace(/\b(true|false|null)\b/gi, (match) => match.toLowerCase());

  return cleaned;
}

function tryParseJsonWithSanitise(jsonText: string): any {
  try {
    return JSON.parse(jsonText);
  } catch {
    const cleaned = sanitizeJsonText(jsonText);
    return JSON.parse(cleaned);
  }
}

function parseLlmSentiment(rawText: string): EnhancedSentimentResult {
  const jsonText = findJsonText(rawText);
  if (!jsonText) {
    log.warn("Invalid LLM JSON response", { rawResponse: rawText });
    throw new Error("LLM did not return valid JSON.");
  }

  let parsed: Partial<EnhancedSentimentResult>;
  try {
    parsed = tryParseJsonWithSanitise(jsonText) as Partial<EnhancedSentimentResult>;
  } catch (err) {
    const message = (err as Error).message;
    const debugFilename = `llm-failure-single-${Date.now()}.json`;
    dumpLlmOutputFile(debugFilename, {
      rawResponse: rawText,
      extractedJson: jsonText,
      parseError: message,
    });
    log.warn("Failed to parse extracted LLM JSON", {
      rawResponse: rawText,
      extractedJson: jsonText,
      parseError: message,
      debugFile: path.join(LLM_OUTPUT_DIR, debugFilename),
    });
    console.warn("LLM parse failure raw response:", rawText);
    console.warn("Extracted JSON candidate:", jsonText);
    console.warn("Parse error:", message);
    throw new Error("LLM did not return valid JSON.");
  }
  const score = parsed.overallSentiment ?? parsed.score;
  const recommendation = parsed.recommendation ?? { action: "hold", conviction: 0.5 };
  const aspects = parsed.aspects ?? {
    earnings: "neutral",
    guidance: "neutral",
    management: "neutral",
    macro: "neutral",
  };

  const keyFindings = (parsed.keyFindings ?? (parsed as any).key_phrases) as string[] | undefined;

  if (
    score === undefined ||
    parsed.label === undefined ||
    parsed.confidence === undefined ||
    parsed.themes === undefined ||
    keyFindings === undefined ||
    parsed.reasoning === undefined ||
    parsed.analystSignals === undefined
  ) {
    throw new Error("LLM sentiment response is missing required fields.");
  }

  return {
    score: score as -1 | 0 | 1,
    overallSentiment: score as -1 | 0 | 1,
    label: parsed.label,
    confidence: Math.max(0, Math.min(1, parsed.confidence)),
    themes: parsed.themes,
    keyFindings,
    aspects,
    recommendation: {
      action: recommendation.action,
      conviction: Math.max(0, Math.min(1, Number(recommendation.conviction ?? 0.5))),
    },
    reasoning: parsed.reasoning,
    analystSignals: parsed.analystSignals,
    method: parsed.method ?? "llm",
  };
}

function classifyFallbackSentiment(headlines: string[]): { score: number; label: "positive" | "neutral" | "negative"; reasoning: string; analystSignals: string[] } {
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
      reasoning: "No recent headlines available.",
      analystSignals: [],
    };
  }

  const score = headlines.reduce((sum, headline) => {
    const lower = headline.toLowerCase();
    let value = 0;
    if (/\b(upgrade|buy|outperform|accumulate|overweight|target raised|strong|beat|surge|profit|growth|optimistic)\b/i.test(lower)) value += 1;
    if (/\b(downgrade|sell|underperform|underweight|target cut|weak|miss|loss|decline|concern|risk|bearish)\b/i.test(lower)) value -= 1;
    return sum + value;
  }, 0);

  const label: "positive" | "neutral" | "negative" = score > 0 ? "positive" : score < 0 ? "negative" : "neutral";

  return {
    score: label === "positive" ? 1 : label === "negative" ? -1 : 0,
    label,
    reasoning: `Keyword-based fallback sentiment for ${headlines.length} headline(s).`,
    analystSignals: analystSignals.slice(0, 3),
  };
}

function buildPrompt(
  symbol: string,
  headlines: string[],
  analystNote: string,
  earningsExcerpt: string
): string {
  const compactHeadlines = headlines.slice(0, 3).map((headline, index) => `${index + 1}. ${headline}`).join("\n") || "None";

  return (
    `You are a financial sentiment analyzer. Analyze the recent sentiment for ${symbol}.\n` +
    `Return valid JSON only with this exact shape:\n` +
    `{"label":"positive|neutral|negative","confidence":0.0,"themes":["theme"],"recommendation":{"action":"buy|hold|sell","conviction":0.0},"reasoning":"short explanation","analystSignals":["signal"]}\n` +
    `Rules: keep the response compact; use at most 3 themes and 3 analyst signals.\n` +
    `Headlines:\n${compactHeadlines}\n` +
    `Analyst/Brokerage Note: ${analystNote || "none"}\n` +
    `Earnings Excerpt: ${earningsExcerpt || "none"}\n`
  );
}

export async function analyzeSentimentWithLLM(
  headlines: string[],
  symbol: string,
  analystNote: string,
  earningsExcerpt: string
): Promise<EnhancedSentimentResult> {
  const cacheKey = makeCacheKey(symbol, headlines, analystNote, earningsExcerpt);
  const now = Date.now();
  const cached = llmCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  const llm = createLLM();
  const prompt = buildPrompt(symbol, headlines, analystNote, earningsExcerpt);

  const response = await llm.call([new HumanMessage(prompt)]) as any;
  const text = response?.text ?? String(response);

  const sentiment = parseLlmSentiment(text);
  sentiment.method = "llm";

  llmCache.set(cacheKey, {
    result: sentiment,
    expiresAt: now + CACHE_TTL_MS,
  });

  return sentiment;
}

export async function analyzeSentimentWithLLMBatch(
  items: Array<{ symbol: string; headlines: string[]; analystNote: string; earningsExcerpt: string }>
): Promise<Record<string, EnhancedSentimentResult>> {
  if (!items || items.length === 0) return {};

  const results: Record<string, EnhancedSentimentResult> = {};
  const pending: Array<{ symbol: string; headlines: string[]; analystNote: string; earningsExcerpt: string }> = [];
  const now = Date.now();

  for (const item of items) {
    const cacheKey = makeCacheKey(item.symbol, item.headlines, item.analystNote, item.earningsExcerpt);
    const cached = llmCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      results[item.symbol] = cached.result;
    } else {
      pending.push(item);
    }
  }

  if (pending.length === 0) {
    return results;
  }

  const llm = createLLM();
  const buildBatchPrompt = (itemsParam: Array<{ symbol: string; headlines: string[]; analystNote: string; earningsExcerpt: string }>) => {
    const sections = itemsParam
      .map((it: { symbol: string; headlines: string[]; analystNote: string; earningsExcerpt: string }) => {
        const compactHeadlines = it.headlines.slice(0, 3).map((h: string, i: number) => `${i + 1}. ${h}`).join("\n") || "None";
        return `---\nSymbol: ${it.symbol}\nHeadlines:\n${compactHeadlines}\nAnalyst/Brokerage Note: ${it.analystNote || "none"}\nEarnings Excerpt: ${it.earningsExcerpt || "none"}`;
      })
      .join("\n\n");

    return (
      `You are a financial sentiment analyzer. For each symbol below, analyze the headlines and note. Return compact valid JSON only as an object keyed by symbol.\n` +
      `Example: {"INFY":{"label":"positive","confidence":0.82,"themes":["earnings"],"recommendation":{"action":"buy","conviction":0.8},"reasoning":"short explanation","analystSignals":["upgrade"]}}\n` +
      `Rules: keep output compact; use at most 3 themes and 3 analyst signals.\n\n` +
      sections
    );
  };

  const prompt = buildBatchPrompt(pending);
  const response = await llm.call([new HumanMessage(prompt)]) as any;
  const text = response?.text ?? String(response);

  const jsonText = findJsonText(text);
  if (!jsonText) {
    log.warn("Invalid LLM batch JSON response", { rawResponse: text });
    throw new Error("LLM did not return valid JSON.");
  }

  let parsed: Record<string, any> | any[];
  try {
    parsed = tryParseJsonWithSanitise(jsonText) as Record<string, any> | any[];
  } catch (err) {
    const message = (err as Error).message;
    const debugFilename = `llm-failure-batch-${Date.now()}.json`;
    dumpLlmOutputFile(debugFilename, {
      rawResponse: text,
      extractedJson: jsonText,
      parseError: message,
    });
    log.warn("Failed to parse extracted LLM batch JSON", {
      rawResponse: text,
      extractedJson: jsonText,
      parseError: message,
      debugFile: path.join(LLM_OUTPUT_DIR, debugFilename),
    });
    console.warn("LLM batch parse failure raw response:", text);
    console.warn("Extracted JSON candidate:", jsonText);
    console.warn("Parse error:", message);
    throw new Error("LLM did not return valid JSON.");
  }

  if (Array.isArray(parsed)) {
    parsed = Object.fromEntries(
      parsed
        .filter((item) => item && typeof item.symbol === "string")
        .map((item) => [item.symbol, item])
    );
  }

  const parsedObject = (parsed ?? {}) as Record<string, any>;

  for (const it of pending) {
    const raw = parsedObject[it.symbol];
    if (!raw || typeof raw !== "object") {
      log.warn("LLM batch response missing entry; falling back to keyword sentiment", { symbol: it.symbol });
      const fallback = convertKeywordSentiment(classifyFallbackSentiment(it.headlines));
      results[it.symbol] = fallback;
      continue;
    }

    const label = typeof raw.label === "string" ? raw.label : (raw.overall_sentiment === 1 ? "positive" : raw.overall_sentiment === -1 ? "negative" : "neutral");
    const score = typeof raw.overall_sentiment === "number"
      ? raw.overall_sentiment
      : label === "positive"
      ? 1
      : label === "negative"
      ? -1
      : 0;
    const confidence = Math.max(0, Math.min(1, Number(raw.confidence ?? 0.5)));
    const themes = Array.isArray(raw.themes) ? raw.themes : [];
    const analystSignals = Array.isArray(raw.analystSignals) ? raw.analystSignals : [];
    const recommendation = raw.recommendation ?? {
      action: label === "positive" ? "buy" : label === "negative" ? "sell" : "hold",
      conviction: 0.5,
    };
    const reasoning = typeof raw.reasoning === "string" && raw.reasoning.trim()
      ? raw.reasoning
      : `${label} sentiment based on the provided headlines.`;
    const keyFindings = Array.isArray(raw.keyFindings) ? raw.keyFindings : (Array.isArray(raw.key_phrases) ? raw.key_phrases : themes.slice(0, 3));
    const aspects = raw.aspects ?? { earnings: "neutral", guidance: "neutral", management: "neutral", macro: "neutral" };

    const sentiment: EnhancedSentimentResult = {
      score: score as -1 | 0 | 1,
      overallSentiment: score as -1 | 0 | 1,
      label: label as EnhancedSentimentResult["label"],
      confidence,
      themes,
      keyFindings,
      aspects,
      recommendation: {
        action: recommendation.action,
        conviction: Math.max(0, Math.min(1, Number(recommendation.conviction ?? 0.5))),
      },
      reasoning,
      analystSignals,
      method: raw.method ?? "llm",
    };

    const cacheKey = makeCacheKey(it.symbol, it.headlines, it.analystNote, it.earningsExcerpt);
    llmCache.set(cacheKey, { result: sentiment, expiresAt: now + CACHE_TTL_MS });
    results[it.symbol] = sentiment;
  }

  return results;
}

export function convertKeywordSentiment(
  fallback: {
    score: number;
    label: string;
    reasoning: string;
    analystSignals: string[];
  }
): EnhancedSentimentResult {
  const label = fallback.label as EnhancedSentimentResult["label"];
  const action = label === "positive" ? "buy" : label === "negative" ? "sell" : "hold";
  const conviction = label === "positive" ? 0.7 : label === "negative" ? 0.7 : 0.5;

  return {
    score: fallback.score as -1 | 0 | 1,
    overallSentiment: fallback.score as -1 | 0 | 1,
    label,
    confidence: 0.35,
    themes: [],
    keyFindings: [],
    aspects: {
      earnings: "neutral",
      guidance: "neutral",
      management: "neutral",
      macro: "neutral",
    },
    recommendation: {
      action,
      conviction,
    },
    reasoning: fallback.reasoning,
    analystSignals: fallback.analystSignals,
    method: "keyword",
  };
}
