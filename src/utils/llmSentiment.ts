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
const LLM_BATCH_CHUNK_SIZE = 6;

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

function buildPrompt(
  symbol: string,
  headlines: string[],
  analystNote: string,
  earningsExcerpt: string
): string {
  return (
    `You are a financial analysis assistant. Analyse the recent sentiment for ${symbol} using the provided headlines, analyst/brokerage note, and earnings excerpt.\n` +
    `Provide a single valid JSON object with these properties:\n` +
    `  - overall_sentiment: -1, 0, or 1\n` +
    `  - label: positive, neutral, or negative\n` +
    `  - confidence: a number between 0 and 1\n` +
    `  - themes: an array of up to 4 short themes summarizing mood and catalysts\n` +
    `  - key_phrases: an array of up to 6 important phrases from the content\n` +
    `  - aspects: { earnings, guidance, management, macro }\n` +
    `  - recommendation: { action: buy, hold, or sell, conviction: 0..1 }\n` +
    `  - reasoning: a concise explanation\n` +
    `  - analystSignals: an array of analyst/brokerage tone indicators\n` +
    `  - keyFindings: an array of up to 4 concise observations\n` +
    `Use only valid JSON. Do not include markdown, backticks, or any text outside the JSON object.\n` +
    `Example: {"overall_sentiment": 1, "label": "positive", "confidence": 0.85, "themes": ["earnings", "brokerage upgrade"], "key_phrases": ["upgrade", "strong guidance"], "aspects": {"earnings": "positive", "guidance": "positive", "management": "neutral", "macro": "neutral"}, "recommendation": {"action": "buy", "conviction": 0.75}, "reasoning": "Strong analyst tone and earnings signals.", "analystSignals": ["upgrade"], "keyFindings": ["positive analyst comments"]}\n` +
    `Headlines:\n` +
    headlines.map((headline, index) => `${index + 1}. ${headline}`).join("\n") +
    "\n" +
    `Analyst/Brokerage Note: ${analystNote || "None available."}\n` +
    `Earnings Excerpt: ${earningsExcerpt || "None available."}\n`
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

  const llm = createLLM();

  const buildBatchPrompt = (itemsParam: Array<{ symbol: string; headlines: string[]; analystNote: string; earningsExcerpt: string }>) => {
    const sections = itemsParam
      .map((it: { symbol: string; headlines: string[]; analystNote: string; earningsExcerpt: string }, idx: number) => {
        return (
          `---\nSymbol: ${it.symbol}\nHeadlines:\n` +
          it.headlines.map((h: string, i: number) => `${i + 1}. ${h}`).join("\n") +
          "\n" +
          `Analyst/Brokerage Note: ${it.analystNote || "None available."}\n` +
          `Earnings Excerpt: ${it.earningsExcerpt || "None available."}\n`
        );
      })
      .join("\n");

    return (
      `You are a financial analysis assistant. For each symbol section below, analyse the recent sentiment using the provided headlines, analyst/brokerage note, and earnings excerpt.\n` +
      `Return a single valid JSON object whose keys are the tickers (exactly as given) and whose values are objects with these properties:\n` +
      `  - overall_sentiment: -1, 0, or 1\n` +
      `  - label: positive, neutral, or negative\n` +
      `  - confidence: a number between 0 and 1\n` +
      `  - themes: an array of up to 4 short themes summarizing mood and catalysts\n` +
      `  - key_phrases: an array of up to 6 important phrases from the content\n` +
      `  - aspects: { earnings, guidance, management, macro }\n` +
      `  - recommendation: { action: buy, hold, or sell, conviction: 0..1 }\n` +
      `  - reasoning: a concise explanation\n` +
      `  - analystSignals: an array of analyst/brokerage tone indicators\n` +
      `Use only valid JSON. Do not include markdown, backticks, or any text outside the JSON object.\n` +
      `Example: {"INFY": {"overall_sentiment": 1, "label": "positive", "confidence": 0.9, "themes": ["earnings", "upgrade"], "key_phrases": ["upgrade", "strong guidance"], "aspects": {"earnings": "positive", "guidance": "positive", "management": "neutral", "macro": "neutral"}, "recommendation": {"action": "buy", "conviction": 0.75}, "reasoning": "Positive sentiment from headlines and analyst tone.", "analystSignals": ["upgrade"], "keyFindings": ["positive upgrade commentary"]}}\n\n` +
      sections
    );
  };

  const prompt = buildBatchPrompt(items);
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

  const now = Date.now();
  const results: Record<string, EnhancedSentimentResult> = {};

  for (const it of items) {
    const raw = parsed[it.symbol];
    if (!raw) {
      throw new Error(`LLM batch response missing entry for ${it.symbol}`);
    }

    const score = raw.overall_sentiment ?? raw.overallSentiment ?? raw.score;
    const recommendation = raw.recommendation ?? { action: "hold", conviction: 0.5 };
    const aspects = raw.aspects ?? { earnings: "neutral", guidance: "neutral", management: "neutral", macro: "neutral" };
    const keyFindings = raw.keyFindings ?? raw.key_phrases ?? raw.key_phrases ?? [];

    if (
      score === undefined ||
      raw.label === undefined ||
      raw.confidence === undefined ||
      raw.themes === undefined ||
      keyFindings === undefined ||
      raw.reasoning === undefined ||
      raw.analystSignals === undefined
    ) {
      throw new Error("LLM sentiment response is missing required fields.");
    }

    const sentiment: EnhancedSentimentResult = {
      score: score as -1 | 0 | 1,
      overallSentiment: score as -1 | 0 | 1,
      label: raw.label,
      confidence: Math.max(0, Math.min(1, raw.confidence)),
      themes: raw.themes,
      keyFindings: keyFindings,
      aspects,
      recommendation: {
        action: recommendation.action,
        conviction: Math.max(0, Math.min(1, Number(recommendation.conviction ?? 0.5))),
      },
      reasoning: raw.reasoning,
      analystSignals: raw.analystSignals,
      method: raw.method ?? "llm",
    };

    // cache per-item
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
