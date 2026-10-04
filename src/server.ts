import "dotenv/config";
import express from "express";
import cors from "cors";

import { scopedLogger } from "./utils/logger";
import { getHoldingsRaw } from "./tools/getHoldings";
import { scrapeRecommendations, filterBuyRecommendations } from "./tools/brokerageRecommendations";
import {
  runPnLCommand,
  runRiskSentimentCommand,
  runStockRecommendationCommand,
  runRebalanceCommand,
  parseTargetWeights,
} from "./agents/rebalancingAgent";
import { computeRebalancingPlan } from "./tools/rebalancePortfolio";
import { executeBatchOrders } from "./tools/placeOrder";
import type { OrderType, TransactionType } from "./types/index";

const log = scopedLogger("server");

const app = express();
app.use(cors());
app.use(express.json());

// Serve React build if available so the app and API are a single portal.
import path from "path";
const webDist = path.join(__dirname, "..", "web", "dist");
try {
  app.use(express.static(webDist));
  // For any other routes not handled above, send React's index.html
  app.get("/*", (req, res, next) => {
    // If the request looks like an API call, skip to next handlers
    if (req.path.startsWith("/api/") || req.path === "/api") return next();
    res.sendFile(path.join(webDist, "index.html"), (err) => {
      if (err) next();
    });
  });
} catch (e) {
  // ignore if web/dist does not exist during dev
}

app.get("/", (_req, res) => {
  res.type("html").send(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Zerodha Rebalancer API Portal</title>
        <style>
          body { margin: 0; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f7fb; color: #111827; }
          .container { max-width: 1000px; margin: 0 auto; padding: 32px 24px; }
          header { text-align: center; margin-bottom: 32px; }
          h1 { margin: 0; font-size: clamp(2rem, 2.8vw, 3rem); letter-spacing: -0.04em; }
          p.lead { margin: 12px auto 0; max-width: 700px; color: #4b5563; line-height: 1.75; }
          .grid { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
          .card { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 20px; box-shadow: 0 16px 40px rgba(15, 23, 42, 0.06); padding: 24px; transition: transform 0.2s ease, border-color 0.2s ease; }
          .card:hover { transform: translateY(-2px); border-color: #cbd5e1; }
          .card h2 { margin: 0 0 10px; font-size: 1.25rem; }
          .card p { margin: 0 0 14px; color: #4b5563; line-height: 1.7; }
          .badge { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.35rem 0.75rem; background: #eff6ff; color: #1d4ed8; border-radius: 999px; font-size: 0.825rem; font-weight: 600; }
          .endpoint { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; display: block; padding: 10px 12px; background: #f9fafb; border-radius: 12px; color: #111827; border: 1px solid #e5e7eb; margin-bottom: 12px; }
          .footer { margin-top: 40px; text-align: center; color: #6b7280; font-size: 0.95rem; }
          a { color: #1d4ed8; text-decoration: none; }
          a:hover { text-decoration: underline; }
        </style>
      </head>
      <body>
        <div class="container">
          <header>
            <div class="badge">Zerodha Rebalancer API</div>
            <h1>Portfolio UI Portal</h1>
            <p class="lead">This portal exposes the backend API for holdings, PnL, risk analysis, rebalance planning, order execution, and natural-language queries.</p>
          </header>

          <div class="grid">
            <section class="card">
              <h2>Health Check</h2>
              <p>Confirm the API is running and reachable.</p>
              <span class="endpoint">GET /api/health</span>
            </section>

            <section class="card">
              <h2>Portfolio Holdings</h2>
              <p>Fetch current Zerodha portfolio holdings with weights, current value, and unrealised PnL.</p>
              <span class="endpoint">GET /api/holdings</span>
            </section>

            <section class="card">
              <h2>Monthly PnL</h2>
              <p>Compute monthly profit and loss over a date range for the current portfolio.</p>
              <span class="endpoint">POST /api/pnl</span>
              <p>Body: <code>{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }</code></p>
            </section>

            <section class="card">
              <h2>Risk &amp; Sentiment</h2>
              <p>Analyze volatility, beta, correlations and sentiment for the current holdings.</p>
              <span class="endpoint">GET /api/risk?lookback=90</span>
            </section>

            <section class="card">
              <h2>Stock Recommendations</h2>
              <p>Rank NSE buy ideas using fundamentals, news sentiment, and sector diversification.</p>
              <span class="endpoint">GET /api/recommend?top=8</span>
            </section>

            <section class="card">
              <h2>Rebalance Plan</h2>
              <p>Generate a target allocation plan for your portfolio without placing orders.</p>
              <span class="endpoint">POST /api/rebalance</span>
              <p>Body: <code>{ "targetWeights": { "INFY": 30, "TCS": 40, "HDFC": 30 } }</code></p>
            </section>

            <section class="card">
              <h2>Execute Rebalance</h2>
              <p>Place orders for the computed rebalance plan. Guarded by API token.</p>
              <span class="endpoint">POST /api/rebalance/execute</span>
              <p>Header: <code>Authorization: Bearer &lt;ADMIN_API_TOKEN&gt;</code></p>
            </section>

            <section class="card">
              <h2>Agent Query</h2>
              <p>Send a natural language prompt to the agent and get a response.</p>
              <span class="endpoint">POST /api/query</span>
              <p>Body: <code>{ "prompt": "show me the portfolio risk" }</code></p>
            </section>
          </div>

          <div class="footer">Use the API endpoints above from your React frontend or directly from tools like curl, Postman, or a browser extension.</div>
        </div>
      </body>
    </html>
  `);
});

app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date() }));

app.get("/api/holdings", async (_req, res) => {
  try {
    const data = await getHoldingsRaw();
    res.json(data);
  } catch (err) {
    log.error("/api/holdings failed", { error: (err as Error).message });
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/pnl", async (req, res) => {
  try {
    const { from, to } = req.body || {};
    const result = await runPnLCommand(from, to);
    if (!result.success) return res.status(500).json({ error: result.error });
    return res.json(result.pnlReport);
  } catch (err) {
    log.error("/api/pnl failed", { error: (err as Error).message });
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/risk", async (req, res) => {
  try {
    const lookback = Number(req.query.lookback) || 90;
    const result = await runRiskSentimentCommand(lookback);
    if (!result.success) return res.status(500).json({ error: result.error });
    return res.json(result.riskReport);
  } catch (err) {
    log.error("/api/risk failed", { error: (err as Error).message });
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/recommend/scrape", async (req, res) => {
  try {
    const upside = Number(req.query.upside) || 0;
    const { recommendations } = await scrapeRecommendations();
    const buyRecommendations = filterBuyRecommendations(recommendations, {
      minUpsidePct: upside,
    });
    return res.json({ count: buyRecommendations.length, recommendations: buyRecommendations });
  } catch (err) {
    log.error("/api/recommend/scrape failed", { error: (err as Error).message });
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/recommend", async (req, res) => {
  try {
    const top = Number(req.query.top) || 8;
    const topN = top >= 5 && top <= 10 ? top : 8;
    const includeHoldings = req.query.includeHoldings !== "false";
    const scope = (req.query.scope as string | undefined) === "nifty" ? "nifty" : "multicap";
    const result = await runStockRecommendationCommand(topN, includeHoldings, scope);
    if (!result.success) return res.status(500).json({ error: result.error });
    return res.json(result.recommendationReport);
  } catch (err) {
    log.error("/api/recommend failed", { error: (err as Error).message });
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/rebalance", async (req, res) => {
  try {
    const { targetWeights, targetWeightsStr, driftThreshold = 2, dryRun = true } = req.body || {};

    let weights = targetWeights as Record<string, number> | undefined;
    if (!weights && targetWeightsStr) weights = parseTargetWeights(targetWeightsStr);
    if (!weights) return res.status(400).json({ error: "targetWeights or targetWeightsStr required" });

    const { holdings, totalValue } = await getHoldingsRaw();
    const plan = computeRebalancingPlan(holdings, totalValue, weights, driftThreshold);
    return res.json({ plan, dryRun });
  } catch (err) {
    log.error("/api/rebalance failed", { error: (err as Error).message });
    res.status(500).json({ error: (err as Error).message });
  }
});

// Execute rebalance: guarded by ADMIN_API_TOKEN env var (Bearer token)
app.post("/api/rebalance/execute", async (req, res) => {
  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
    if (!process.env.ADMIN_API_TOKEN) {
      log.warn("ADMIN_API_TOKEN not set — refusing to execute orders");
      return res.status(403).json({ error: "Server not configured to execute orders" });
    }
    if (token !== process.env.ADMIN_API_TOKEN) return res.status(401).json({ error: "unauthorized" });

    const { targetWeights, targetWeightsStr, driftThreshold = 2 } = req.body || {};
    let weights = targetWeights as Record<string, number> | undefined;
    if (!weights && targetWeightsStr) weights = parseTargetWeights(targetWeightsStr);
    if (!weights) return res.status(400).json({ error: "targetWeights or targetWeightsStr required" });

    const { holdings, totalValue } = await getHoldingsRaw();
    const plan = computeRebalancingPlan(holdings, totalValue, weights, driftThreshold);

    if (!plan.suggestions || plan.suggestions.length === 0) return res.json({ plan, results: [] });

    // Map suggestions to order shape expected by executeBatchOrders
    const orders: Array<{ symbol: string; transactionType: TransactionType; quantity: number; orderType: OrderType }> = plan.suggestions.map((s) => ({
      symbol: s.symbol,
      transactionType: s.action,
      quantity: s.quantity,
      orderType: "MARKET" as OrderType,
    }));

    const results = await executeBatchOrders(orders);
    return res.json({ plan, results });
  } catch (err) {
    log.error("/api/rebalance/execute failed", { error: (err as Error).message });
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/query", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "prompt is required" });
    const answer = await runAgentQuery(prompt as string).catch((e) => ({ error: e.message }));
    return res.json({ answer });
  } catch (err) {
    log.error("/api/query failed", { error: (err as Error).message });
    res.status(500).json({ error: (err as Error).message });
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => log.info(`Server listening on http://localhost:${port}`));

// Helper: re-export runAgentQuery lazily to avoid circular import ordering issues
async function runAgentQuery(prompt: string) {
  const mod = await import("./agents/rebalancingAgent");
  return mod.runAgentQuery(prompt);
}

export default app;
