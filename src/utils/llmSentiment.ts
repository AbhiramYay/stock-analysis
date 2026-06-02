import { HumanMessage } from "@langchain/core/messages";
import { scopedLogger } from "./logger";
import { createLLM } from "./llmFactory";
import type { EnhancedSentimentResult } from "../types/index";

const log = scopedLogger("llmSentiment");

const llmCache = new Map<string, { result: EnhancedSentimentResult; expiresAt: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function makeCacheKey(
  symbol: string,
  headlines: string[],
  analystNote: string,
  earningsExcerpt: string
): string {
  return `${symbol}:${headlines.join("||")}:${analystNote}:${earningsExcerpt}`;
}

function cleanJsonResponse(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

function parseLlmSentiment(rawText: string): EnhancedSentimentResult {
  const jsonText = cleanJsonResponse(rawText);
  if (!jsonText) {
    throw new Error("LLM did not return valid JSON.");
  }

  const parsed = JSON.parse(jsonText) as Partial<EnhancedSentimentResult>;
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
