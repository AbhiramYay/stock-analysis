import "dotenv/config";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatGroq } from "@langchain/groq";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { scopedLogger } from "./logger";

const log = scopedLogger("llmFactory");

export function createLLM(): BaseChatModel {
  const provider = (process.env.LLM_PROVIDER ?? "gemini").toLowerCase();

  if (provider === "gemini") {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GOOGLE_API_KEY is not set.\n" +
          "  Get a free key (no credit card) at: https://aistudio.google.com/apikey\n" +
          "  Free limits: 1,000 req/day · 250,000 tokens/min"
      );
    }
    const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite";
    log.info("Using Google Gemini (FREE)", { model });
    return new ChatGoogleGenerativeAI({
      model,
      apiKey,
      temperature: 0,
      maxOutputTokens: 8192,
    }) as unknown as BaseChatModel;
  }

  if (provider === "groq") {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GROQ_API_KEY is not set.\n" +
          "  Get a free key (no credit card) at: https://console.groq.com/keys\n" +
          "  Free limits: 1,000 req/day · 6,000 tokens/min"
      );
    }
    const model = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
    log.info("Using Groq (FREE)", { model });
    return new ChatGroq({
      model,
      apiKey,
      temperature: 0,
    }) as unknown as BaseChatModel;
  }

  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in .env");
    log.info("Using Anthropic Claude (paid)");
    return new ChatAnthropic({
      model: "claude-3.5-haiku",
      apiKey,
      maxTokens: 4096,
      temperature: 0,
    }) as unknown as BaseChatModel;
  }

  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set in .env");
    const model = process.env.OPENAI_MODEL ?? "gpt-4o";
    log.info("Using OpenAI (paid)", { model });
    return new ChatOpenAI({
      model,
      apiKey,
      temperature: 0,
    }) as unknown as BaseChatModel;
  }

  throw new Error(
    `Unknown LLM_PROVIDER: "${provider}".\n` +
      `  Valid options: gemini (free), groq (free), openai (paid), anthropic (paid)`
  );
}
