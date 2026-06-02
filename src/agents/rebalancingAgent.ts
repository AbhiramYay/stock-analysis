// ─────────────────────────────────────────────────────────────────────────────
//  src/agents/rebalancingAgent.ts
//  LangChain agent that orchestrates the full rebalancing workflow
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatGroq } from "@langchain/groq";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { getHoldingsTool, getHoldingsRaw } from "../tools/getHoldings";
import { getHistoricalPriceTool } from "../tools/getHistoricalPrice";
import { rebalancePortfolioTool, computeRebalancingPlan } from "../tools/rebalancePortfolio";
import { placeOrderTool, executeBatchOrders } from "../tools/placeOrder";
import {
  riskSentimentTool,
  analyzePortfolioRiskSentiment,
} from "../tools/riskSentiment";
import {
  stockRecommendationTool,
  analyzeStockRecommendations,
} from "../tools/stockRecommendation";
import { calculateMonthlyPnL } from "../utils/pnl";
import { scopedLogger } from "../utils/logger";
import type {
  AgentResult,
  PlacedOrder,
  RebalanceInput,
  TargetWeights,
} from "../types/index";

const log = scopedLogger("RebalancingAgent");

// ─── LLM Factory ─────────────────────────────────────────────────────────────
//
//  Provider priority (set LLM_PROVIDER in .env):
//
//   gemini    → Google Gemini 2.5 Flash-Lite  (FREE — 1,000 req/day, 250K TPM)
//                Get key: https://aistudio.google.com/apikey
//
//   groq      → Groq Llama 3.3 70B            (FREE — 1,000 req/day, 6K TPM)
//                Get key: https://console.groq.com/keys
//
//   openai    → OpenAI GPT-4o                 (paid)
//   anthropic → Anthropic Claude              (paid)

function createLLM(): BaseChatModel {
  const provider = (process.env.LLM_PROVIDER ?? "gemini").toLowerCase();

  // ── Google Gemini 2.5 Flash-Lite (FREE default) ──────────────────────────
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

  // ── Groq Llama 3.3 70B (FREE fallback) ───────────────────────────────────
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

  // ── Anthropic Claude (paid) ───────────────────────────────────────────────
  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in .env");
    log.info("Using Anthropic Claude (paid)");
    return new ChatAnthropic({
      model: "claude-opus-4-5",
      apiKey,
      maxTokens: 4096,
      temperature: 0,
    }) as unknown as BaseChatModel;
  }

  // ── OpenAI GPT-4o (paid) ──────────────────────────────────────────────────
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

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert Indian stock market portfolio management agent connected to Zerodha Kite Connect.

Your capabilities:
- **getHoldings**: Fetch the user's live portfolio holdings with quantities, prices, values, and weights.
- **getHistoricalPrice**: Retrieve OHLCV data for any NSE/BSE stock on a specific date.
- **rebalancePortfolio**: Analyse current vs target weights and generate precise trade suggestions.
- **riskSentiment**: Analyse portfolio risk and market sentiment using volatility, beta, correlations and recent headlines.
- **stockRecommendation**: Rank NSE buy ideas using fundamentals, news/analyst sentiment, and sector diversification.
- **placeOrder**: Execute BUY or SELL orders on Zerodha (use only when explicitly asked).

Rebalancing Workflow:
1. Call getHoldings to fetch live portfolio data.
2. Compute current weights from holdings.
3. Call rebalancePortfolio with the user's target weights to get trade suggestions.
4. Present the suggestions clearly: symbol, action (BUY/SELL), quantity, estimated price, estimated value, and reasoning.
5. Only call placeOrder if the user explicitly says "execute" or "confirm trades".

Guidelines:
- All prices are in Indian Rupees (₹).
- Default exchange is NSE. Use BSE only when explicitly requested.
- Target weights must sum to 100%.
- Avoid over-trading: skip trades where drift < 2% unless overridden.
- Always present a summary of net cash required (positive = need funds, negative = proceeds from sells).
- For PnL queries, use getHistoricalPrice to fetch last month's open/close and compute per-stock gains/losses.
- Be concise and precise. No hedging or unnecessary caveats.`;

// ─── Agent Factory ────────────────────────────────────────────────────────────

function buildAgent() {
  const llm = createLLM();
  const tools = [
    getHoldingsTool,
    getHistoricalPriceTool,
    rebalancePortfolioTool,
    riskSentimentTool,
    stockRecommendationTool,
    placeOrderTool,
  ];

  const agent = createReactAgent({
    llm,
    tools,
  });

  return agent;
}

// ─── Rebalancing Command ──────────────────────────────────────────────────────

/**
 * Run the full rebalancing workflow:
 *   1. Fetch holdings
 *   2. Compute current weights
 *   3. Generate trade suggestions
 *   4. Optionally execute trades
 */
export async function runRebalanceCommand(
  input: RebalanceInput
): Promise<AgentResult> {
  const start = Date.now();
  log.info("Starting rebalance command", {
    targetWeights: input.targetWeights,
    dryRun: input.dryRun,
    driftThreshold: input.driftThreshold,
  });

  try {
    // ── Step 1 & 2: Fetch holdings ────────────────────────────────────────────
    log.info("Step 1: Fetching portfolio holdings...");
    const { holdings, totalValue, totalPnL } = await getHoldingsRaw();
    log.info(`Portfolio: ${holdings.length} stocks, ₹${totalValue.toFixed(2)} total`);

    const portfolio = {
      holdings,
      totalValue,
      totalPnL,
      fetchedAt: new Date(),
    };

    // ── Step 3 & 4: Generate rebalancing plan ─────────────────────────────────
    log.info("Step 2-4: Computing rebalancing plan...");
    const plan = computeRebalancingPlan(
      holdings,
      totalValue,
      input.targetWeights,
      input.driftThreshold
    );

    log.info(`Rebalancing plan: ${plan.suggestions.length} trades suggested`);
    plan.suggestions.forEach((s) => {
      log.info(`  ${s.action} ${s.quantity}x ${s.symbol} @ ₹${s.estimatedPrice} (~₹${s.estimatedValue.toFixed(0)})`);
    });

    let placedOrders: PlacedOrder[] | undefined;

    // ── Step 5: Optionally execute trades ─────────────────────────────────────
    if (!input.dryRun && plan.suggestions.length > 0) {
      const autoExecute = process.env.AUTO_EXECUTE_TRADES === "true";

      if (autoExecute) {
        log.info("Step 5: Executing trades (AUTO_EXECUTE_TRADES=true)...");
        placedOrders = await executeBatchOrders(
          plan.suggestions.map((s) => ({
            symbol: s.symbol,
            transactionType: s.action,
            quantity: s.quantity,
            orderType: "MARKET" as const,
          }))
        );

        const placed = placedOrders.filter((o) => o.status === "PLACED").length;
        const failed = placedOrders.filter((o) => o.status === "FAILED").length;
        log.info(`Orders: ${placed} placed, ${failed} failed`);
      } else {
        log.info(
          "Step 5: Skipped order execution (dry run or AUTO_EXECUTE_TRADES not set). " +
          "Use --execute flag or set AUTO_EXECUTE_TRADES=true to execute."
        );
      }
    } else if (input.dryRun) {
      log.info("Step 5: Dry run mode — no orders placed.");
    }

    return {
      success: true,
      command: "rebalance",
      portfolio,
      plan,
      placedOrders,
      executionTimeMs: Date.now() - start,
    };
  } catch (err) {
    const error = (err as Error).message;
    log.error("Rebalance command failed", { error });
    return {
      success: false,
      command: "rebalance",
      error,
      executionTimeMs: Date.now() - start,
    };
  }
}

// ─── Risk & Sentiment Analysis Command ───────────────────────────────────────

export async function runRiskSentimentCommand(
  lookbackDays = 90
): Promise<AgentResult> {
  const start = Date.now();
  log.info("Starting risk and sentiment analysis", { lookbackDays });

  try {
    const { holdings, totalValue, totalPnL } = await getHoldingsRaw();
    const portfolio = {
      holdings,
      totalValue,
      totalPnL,
      fetchedAt: new Date(),
    };

    const riskReport = await analyzePortfolioRiskSentiment(lookbackDays);

    log.info("Risk and sentiment analysis complete", {
      stocks: holdings.map((h) => h.symbol),
      benchmark: riskReport.benchmarkSymbol,
    });

    return {
      success: true,
      command: "analysis",
      portfolio,
      riskReport,
      executionTimeMs: Date.now() - start,
    };
  } catch (err) {
    const error = (err as Error).message;
    log.error("Risk and sentiment analysis failed", { error });
    return {
      success: false,
      command: "analysis",
      error,
      executionTimeMs: Date.now() - start,
    };
  }
}

// ─── Stock Recommendation Command ────────────────────────────────────────────

export async function runStockRecommendationCommand(
  topN = 8,
  includeHoldings = true
): Promise<AgentResult> {
  const start = Date.now();
  log.info("Starting stock recommendation command", { topN, includeHoldings });

  try {
    const recommendationReport = await analyzeStockRecommendations({
      topN,
      includeHoldings,
    });

    return {
      success: true,
      command: "recommend",
      recommendationReport,
      executionTimeMs: Date.now() - start,
    };
  } catch (err) {
    const error = (err as Error).message;
    log.error("Stock recommendation command failed", { error });
    return {
      success: false,
      command: "recommend",
      error,
      executionTimeMs: Date.now() - start,
    };
  }
}

// ─── PnL Command ─────────────────────────────────────────────────────────────

/**
 * Run the monthly PnL analysis:
 *   1. Fetch holdings
 *   2. Fetch historical prices for last month
 *   3. Compute per-stock and total PnL
 */
export async function runPnLCommand(fromDate?: string, toDate?: string): Promise<AgentResult> {
  const start = Date.now();
  log.info("Starting monthly PnL command...", { fromDate, toDate });

  try {
    // Step 1: Fetch holdings
    log.info("Step 1: Fetching portfolio holdings...");
    const { holdings, totalValue, totalPnL } = await getHoldingsRaw();

    const portfolio = {
      holdings,
      totalValue,
      totalPnL,
      fetchedAt: new Date(),
    };

    // Step 2+3: Compute monthly PnL (fetches historical prices internally)
    log.info("Step 2: Computing monthly PnL...");
    const pnlReport = await calculateMonthlyPnL(holdings, fromDate, toDate);

    log.info("Monthly PnL computed", {
      totalPnL: `₹${pnlReport.totalPnLAbsolute.toFixed(2)}`,
      pct: `${pnlReport.totalPnLPercent.toFixed(2)}%`,
    });

    return {
      success: true,
      command: "pnl",
      portfolio,
      pnlReport,
      executionTimeMs: Date.now() - start,
    };
  } catch (err) {
    const error = (err as Error).message;
    log.error("PnL command failed", { error });
    return {
      success: false,
      command: "pnl",
      error,
      executionTimeMs: Date.now() - start,
    };
  }
}

// ─── Natural Language Agent ───────────────────────────────────────────────────

/**
 * Run the LangChain ReAct agent with a free-form natural language prompt.
 * The agent will decide which tools to call based on the query.
 */
export async function runAgentQuery(userQuery: string): Promise<string> {
  log.info("Starting agent query", { query: userQuery });

  const agent = buildAgent();

  const result = await agent.invoke({
    messages: [
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(userQuery),
    ],
  });

  // Extract the final assistant message
  const messages = result.messages as Array<{ role?: string; content: unknown }>;
  const lastMessage = messages[messages.length - 1];
  const content = lastMessage?.content;

  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: string; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }

  return JSON.stringify(content);
}

// ─── Weight Parser ────────────────────────────────────────────────────────────

/**
 * Parse a target weights string like "INFY:30,TCS:40,HDFC:30"
 * or "INFY 30%, TCS 40%, HDFC 30%" into a TargetWeights object.
 */
export function parseTargetWeights(input: string): TargetWeights {
  const weights: TargetWeights = {};

  // Normalise separators
  const cleaned = input.replace(/%/g, "").trim();

  // Match patterns like "INFY:30", "INFY=30", "INFY 30"
  const pattern = /([A-Z]{2,20})\s*[:=\s]\s*(\d+(?:\.\d+)?)/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(cleaned)) !== null) {
    const symbol = match[1].toUpperCase();
    const weight = parseFloat(match[2]);
    weights[symbol] = weight;
  }

  if (Object.keys(weights).length === 0) {
    throw new Error(
      `Could not parse target weights from: "${input}". ` +
        'Expected format: "INFY:30,TCS:40,HDFC:30" or "INFY 30%, TCS 40%, HDFC 30%"'
    );
  }

  const sum = Object.values(weights).reduce((s, w) => s + w, 0);
  if (Math.abs(sum - 100) > 1) {
    log.warn(
      `Target weights sum to ${sum.toFixed(1)}%, not 100%. ` +
        "Results may be inaccurate."
    );
  }

  return weights;
}
