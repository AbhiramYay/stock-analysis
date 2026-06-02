# 🏦 Zerodha Portfolio Rebalancing Agent

A production-ready TypeScript agent that uses **LangChain.js** and **Zerodha Kite Connect** to analyse your Indian equity portfolio: rebalancing, monthly PnL, risk/sentiment, and **NSE stock buy recommendations** — from the **CLI**, a **REST API**, or a **React dashboard**.

---

## Features

| Feature | CLI | API | Web UI |
|---------|-----|-----|--------|
| Live holdings & weights | `holdings` | `GET /api/holdings` | `/` |
| Monthly PnL + portfolio summary | `pnl` | `POST /api/pnl` | `/pnl` |
| Risk, beta, volatility, news sentiment | `analysis` | `GET /api/risk` | `/risk` |
| NSE buy recommendations (fundamentals + sentiment) | `recommend` | `GET /api/recommend` | `/recommend` |
| Rebalance plan & execute | `rebalance` | `POST /api/rebalance` | `/rebalance` |
| Natural-language agent | `query` | `POST /api/query` | — |

---

## Architecture

```
stock-analysis/
├── src/
│   ├── agents/
│   │   └── rebalancingAgent.ts   # LangChain ReAct agent + command orchestrators
│   ├── tools/                    # LangChain DynamicStructuredTool wrappers
│   │   ├── getHoldings.ts
│   │   ├── getHistoricalPrice.ts
│   │   ├── rebalancePortfolio.ts
│   │   ├── riskSentiment.ts      # Volatility, beta, correlation, news sentiment
│   │   ├── stockRecommendation.ts # Nifty 50 scan: fundamentals + sentiment + diversification
│   │   └── placeOrder.ts
│   ├── data/
│   │   └── nifty50.ts            # NSE large-cap universe for recommendations
│   ├── utils/
│   │   ├── kiteClient.ts         # Kite + Yahoo Finance (prices, sectors)
│   │   ├── yahooFundamentals.ts  # ROE, debt/equity, earnings growth
│   │   ├── newsSentiment.ts      # RSS headlines + analyst-tone scoring
│   │   ├── pnl.ts
│   │   ├── display.ts
│   │   └── logger.ts
│   ├── types/index.ts
│   ├── cli.ts
│   └── server.ts                 # Express API + serves web/dist
├── web/                          # React + Vite + Bootstrap 5 dashboard
│   └── src/
│       ├── components/Holdings.tsx
│       └── pages/ PnL · Risk · Recommend · Rebalance
├── package.json
└── tsconfig.json
```

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Node.js ≥ 18 | [nodejs.org](https://nodejs.org) |
| Zerodha account | Regular login at [kite.zerodha.com](https://kite.zerodha.com) — no API subscription needed |
| LLM API key (Gemini recommended) | Only for `query` / ReAct agent — free tier available (see below) |

---

## Setup

### 1. Clone & install

```bash
git clone <repo>
cd stock-analysis
npm install
cd web && npm install && cd ..
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Zerodha — paste your enctoken from kite.zerodha.com (see Step 3 below)
KITE_ENCTOKEN=your_enctoken_here

# FREE default — Google Gemini (get key at aistudio.google.com/apikey, no card)
LLM_PROVIDER=gemini
GOOGLE_API_KEY=AIza...

# Optional: set to "true" to auto-execute trades without --execute flag
AUTO_EXECUTE_TRADES=false

# Optional: required for POST /api/rebalance/execute from the web UI
ADMIN_API_TOKEN=your_secret_token
```

### 3. Get your Kite enctoken

The enctoken is your Kite **web session cookie** — no API subscription required.

```bash
# Interactive step-by-step guide:
npm run auth
```

Or do it manually in 30 seconds:

1. Log in at **[kite.zerodha.com](https://kite.zerodha.com)**
2. Open DevTools → **Application** → **Cookies** → `kite.zerodha.com`
3. Copy the value of the **`enctoken`** cookie
4. Paste it into `.env` as `KITE_ENCTOKEN=<value>`

Or run this one-liner in the browser console (F12 → Console):
```js
document.cookie.split("; ").find(r => r.startsWith("enctoken"))?.split("=")[1]
```

> ⏰ **The enctoken resets daily at 6 AM IST** when Kite clears your web session.
> Re-run `npm run auth` each morning before using the agent.

### 4. Build

```bash
npm run build
# Compiles all src/**/*.ts → dist/ via @swc/core (~200ms)
```

> **Note on `tsconfig.json`:** This file is required even though the build uses `@swc/core` instead of `tsc`. It serves two purposes:
> - **`ts-node`** reads it for the `npm run dev`, `npm run auth`, and all `npm run dev:*` scripts (which run TypeScript directly without a pre-build step).
> - **IDE / editor** (VS Code, WebStorm, etc.) uses it for type-checking, IntelliSense, and error highlighting.
>
> Do **not** delete `tsconfig.json`.

### 5. Web dashboard (optional)

Run the API server and Vite dev UI in two terminals:

```bash
# Terminal 1 — API on http://localhost:3000
npm run dev:server

# Terminal 2 — React UI on http://localhost:5173 (proxies /api → :3000)
npm run dev:web
```

Open **http://localhost:5173**. Pages: **Holdings**, **PnL**, **Risk**, **Recommend**, **Rebalance**.

The UI uses **Bootstrap 5** (navbar, cards, tables, alerts, badges, forms). All data tables support **click-to-sort** on column headers (⇅ / ↑ / ↓). PnL defaults to highest return %; Recommend shows per-stock reasoning and sector allocation cards.

For a single production-style deploy, build both and start the server (it serves `web/dist`):

```bash
npm run build:all
npm run start:server
```

---

## REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/holdings` | Current portfolio |
| `POST` | `/api/pnl` | Body: `{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }` (optional) |
| `GET` | `/api/risk?lookback=90` | Risk & sentiment report |
| `GET` | `/api/recommend?top=8&includeHoldings=true` | Stock buy recommendations (slow; ~several min) |
| `POST` | `/api/rebalance` | Body: `{ "targetWeightsStr": "INFY:30,TCS:40,HDFC:30" }` |
| `POST` | `/api/rebalance/execute` | Same body + `Authorization: Bearer <ADMIN_API_TOKEN>` |
| `POST` | `/api/query` | Body: `{ "prompt": "..." }` |

---

## CLI Commands

### `rebalance` — Portfolio rebalancing

```bash
# Dry run (no orders placed) — analyse only
npm run dev -- rebalance --weights "INFY:30,TCS:40,HDFC:30"

# With percentage-style input
npm run dev -- rebalance --weights "INFY 30%, TCS 40%, HDFC 30%"

# Execute real trades (⚠️ places live orders on Zerodha)
npm run dev -- rebalance --weights "INFY:30,TCS:40,HDFC:30" --execute

# Custom drift threshold (only suggest trades if drift > 5%)
npm run dev -- rebalance --weights "INFY:30,TCS:40,HDFC:30" --drift 5
```

**Sample Output:**

```
📊 Current Portfolio Holdings

┌──────────┬──────┬───────────┬───────────┬──────────────┬─────────────┬──────────┬─────────┐
│ Symbol   │ Qty  │ Avg Price │ LTP       │ Value (₹)    │ PnL (₹)     │ Day Chg% │ Weight% │
├──────────┼──────┼───────────┼───────────┼──────────────┼─────────────┼──────────┼─────────┤
│ INFY     │ 200  │ ₹1,450.00 │ ₹1,620.50 │ ₹3,24,100.00 │ +₹34,100.00 │ +1.20%   │ 36.20%  │
│ TCS      │ 150  │ ₹3,200.00 │ ₹3,780.00 │ ₹5,67,000.00 │ +₹87,000.00 │ +0.85%   │ 33.80%  │  
│ HDFCBANK │ 350  │ ₹1,540.00 │ ₹1,710.00 │ ₹5,98,500.00 │ +₹59,500.00 │ +1.45%   │ 30.00%  │
│ TOTAL    │      │           │           │ ₹14,89,600   │             │          │ 100%    │
└──────────┴──────┴───────────┴───────────┴──────────────┴─────────────┴──────────┴─────────┘

⚖️  Rebalancing Plan

┌────────┬────────┬─────┬───────────┬──────────────┬──────────┬─────────┬─────────┐
│ Action │ Symbol │ Qty │ Price (₹) │ Value (₹)    │ Current% │ Target% │ Drift   │
├────────┼────────┼─────┼───────────┼──────────────┼──────────┼─────────┼─────────┤
│ [SELL] │ INFY   │ 54  │ ₹1,620.50 │ ₹87,507.00   │ 36.2%    │ 30.0%   │ -6.20%  │
│ [BUY]  │ TCS    │ 17  │ ₹3,780.00 │ ₹64,260.00   │ 33.8%    │ 40.0%   │ +6.20%  │
└────────┴────────┴─────┴───────────┴──────────────┴──────────┴─────────┴─────────┘

  Summary:
    Total BUY  value : ₹64,260.00
    Total SELL value : ₹87,507.00
    Cash freed up    : ₹23,247.00
```

---

### `pnl` — Monthly gains/losses

```bash
# Last calendar month (default)
npm run dev -- pnl

# Custom date range
npm run dev -- pnl --from 2026-04-01 --to 2026-04-30
```

Computes per-stock open/close PnL, a **portfolio summary** (total PnL, PnL %, holding value, best/worst performer), and a sortable breakdown. The web **PnL** page shows the same summary in a card plus a chart and table (default sort: highest **PnL %**).

---

### `recommend` — NSE stock buy recommendations

Scans the **Nifty 50** universe (plus your holdings, unless `--nifty-only`), scores each stock on fundamentals, news/analyst sentiment, and 6-month momentum, then returns **5–10 diversified picks** with reasoning and sector allocation.

```bash
# Top 8 recommendations (default)
npm run dev -- recommend

# Top 10, Nifty 50 only
npm run dev -- recommend --top 10 --nifty-only
```

**Data sources:** Yahoo Finance (ROE, debt/equity, earnings growth, P/E, prices), Yahoo/Google News RSS (headlines and brokerage/analyst tone).

> ⏱ Full scan takes **several minutes** (rate-limited API calls per symbol).  
> ⚠️ **Not financial advice** — verify data before investing.

**Sample output:**

```
📊 NSE Stock Buy Recommendations (India)

  Scanned 50 symbols · 18 passed filters

┌───┬──────────┬─────────────────────────┬───────┬───────┬───────┬───────┬──────────┐
│ # │ Symbol   │ Sector                  │ Score │ Fund. │ Sent. │ Mom.  │ Sentiment│
├───┼──────────┼─────────────────────────┼───────┼───────┼───────┼───────┼──────────┤
│ 1 │ RELIANCE │ Energy                  │ 78.0  │ 32    │ 28    │ 18    │ positive │
└───┴──────────┴─────────────────────────┴───────┴───────┴───────┴───────┴──────────┘

  Sector allocation (recommended basket):
    Energy                       25.0%
    Information Technology       25.0%
    ...
```

---

### `analysis` — Portfolio risk and sentiment analysis

```bash
npm run dev -- analysis
```

```bash
npm run dev -- analysis --lookback 120
```

This command analyses your holdings for volatility, beta, sector concentration, and recent news sentiment, then recommends whether to hold, reduce, or consider increasing exposure. The web **Risk** page adds sector and volatility charts plus a sortable table.

---

### `pnl` sample output

```
📈 Monthly PnL Report  (1 Apr 2025 → 30 Apr 2025)

┌──────────┬─────┬───────────┬───────────┬──────────────┬─────────┬──────────────┐
│ Symbol   │ Qty │ Open ₹    │ Close ₹   │ PnL ₹        │ PnL %   │ Holding ₹    │
├──────────┼─────┼───────────┼───────────┼──────────────┼─────────┼──────────────┤
│ TCS      │ 150 │ ₹3,610.00 │ ₹3,780.00 │ +₹25,500.00  │ +4.71%  │ ₹5,67,000.00 │
│ HDFCBANK │ 350 │ ₹1,650.00 │ ₹1,710.00 │ +₹21,000.00  │ +3.64%  │ ₹5,98,500.00 │
│ INFY     │ 200 │ ₹1,590.00 │ ₹1,620.50 │  +₹6,100.00  │ +1.92%  │ ₹3,24,100.00 │
└──────────┴─────┴───────────┴───────────┴──────────────┴─────────┴──────────────┘

  Portfolio Summary:
    Total PnL     : +₹52,600.00
    PnL %         : +3.53%
    Holding Value : ₹14,89,600.00

    🏆 Best  : TCS (+4.71%)
    📉 Worst : INFY (+1.92%)
```

---

### `holdings` — View portfolio snapshot

```bash
npm run dev -- holdings
```

---

### `query` — Natural language agent

```bash
# Free-form queries processed by the LangChain ReAct agent
npm run dev -- query "rebalance portfolio with target weights INFY 30%, TCS 40%, HDFC 30%"
npm run dev -- query "show last month's gains and losses"
npm run dev -- query "what percentage of my portfolio is in TCS?"
npm run dev -- query "compare my current weights against INFY 25%, TCS 35%, HDFC 25%, WIPRO 15%"
npm run dev -- query "give me top NSE stock buy recommendations with sector diversification"
```

The ReAct agent can call **`stockRecommendation`**, **`riskSentiment`**, **`getHoldings`**, **`rebalancePortfolio`**, and **`placeOrder`** as needed.

---

## TypeScript Interfaces

```typescript
interface Holding {
  symbol: string;
  quantity: number;
  averagePrice: number;
  lastPrice: number;
  currentValue: number;
  pnl: number;
  weight: number;           // % of total portfolio
}

interface TradeSuggestion {
  symbol: string;
  action: "BUY" | "SELL";
  quantity: number;
  estimatedPrice: number;
  estimatedValue: number;
  currentWeight: number;
  targetWeight: number;
  weightDelta: number;
  reasoning: string;
}

type TargetWeights = Record<string, number>;  // { "INFY": 30, "TCS": 40 }

interface StockRecommendation {
  symbol: string;
  sector: string;
  rank: number;
  compositeScore: number;
  fundamentalScore: number;
  sentimentScore: number;
  fundamentalReasoning: string;
  sentimentReasoning: string;
  sentimentLabel: "positive" | "neutral" | "negative";
  fundamentals: { roe: number | null; debtToEquity: number | null; earningsGrowth: number | null };
}
```

---

## LangChain Tools

Six tools are registered on the ReAct agent (README historically called these “MCP tools”; they are standard LangChain `DynamicStructuredTool` instances):

| Tool | Input | What it does |
|------|-------|--------------|
| `getHoldings` | — | Fetch live portfolio, compute weights |
| `getHistoricalPrice` | symbol, date, exchange | OHLCV data for any date |
| `rebalancePortfolio` | targetWeights, driftThreshold | Compute BUY/SELL suggestions |
| `riskSentiment` | lookbackDays | Volatility, beta, correlation, news sentiment for **your holdings** |
| `stockRecommendation` | topN, includeHoldings | Rank **NSE** buy ideas (Nifty 50 + fundamentals + sentiment + diversification) |
| `placeOrder` | symbol, type, qty, price | Execute a real order |

---

## Agent Workflow

```
User: "rebalance INFY 30%, TCS 40%, HDFC 30%"
         │
         ▼
┌─────────────────────┐
│ Step 1: getHoldings │  ← fetches live Kite portfolio
└─────────┬───────────┘
          │
          ▼
┌──────────────────────────────┐
│ Step 2: Compute current      │  ← weight = value / totalPortfolio × 100
│         weights in-memory    │
└─────────┬────────────────────┘
          │
          ▼
┌────────────────────────────────┐
│ Step 3: rebalancePortfolio     │  ← diff current vs target weights
│         (drift threshold: 2%) │  ← skip if |drift| < 2%
└─────────┬──────────────────────┘
          │
          ▼
┌───────────────────────────────────┐
│ Step 4: Present trade suggestions │
│   SELL 54x INFY @ ₹1620.50       │
│   BUY  17x TCS  @ ₹3780.00       │
└─────────┬─────────────────────────┘
          │
          ▼  (only if --execute flag is set)
┌─────────────────────┐
│ Step 5: placeOrder  │  ← places MARKET orders on Kite
└─────────────────────┘
```

---

## Free LLM Models

No credit card is required for either free provider. The agent defaults to Gemini.

### Option 1 — Google Gemini 2.5 Flash-Lite (recommended)

| Limit | Free allowance |
|-------|---------------|
| Requests/day | 1,000 |
| Tokens/minute | 250,000 |
| Context window | 1M tokens |
| Credit card | ❌ Not required |

```bash
# 1. Get a free API key (takes ~1 min, no card):
#    https://aistudio.google.com/apikey

# 2. Set in .env:
LLM_PROVIDER=gemini
GOOGLE_API_KEY=AIza...
GEMINI_MODEL=gemini-2.5-flash-lite   # default, can omit
```

### Option 2 — Groq Llama 3.3 70B (free fallback)

| Limit | Free allowance |
|-------|---------------|
| Requests/day | 1,000 |
| Tokens/minute | 6,000 |
| Inference speed | ~400 tokens/sec (very fast) |
| Credit card | ❌ Not required |

> ⚠️ Groq's 6K TPM can be hit during a complex agent run with large tool responses.
> Prefer Gemini for this agent. Use Groq if you hit Gemini's daily quota.

```bash
# 1. Get a free API key:
#    https://console.groq.com/keys

# 2. Set in .env:
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_...
GROQ_MODEL=llama-3.3-70b-versatile   # default, can omit
```

---

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `KITE_ENCTOKEN` | — | Web session token from kite.zerodha.com cookie (required) |
| `LLM_PROVIDER` | `gemini` | `gemini` · `groq` · `openai` · `anthropic` |
| `GOOGLE_API_KEY` | — | Free Gemini key from aistudio.google.com |
| `GEMINI_MODEL` | `gemini-2.5-flash-lite` | Gemini model name |
| `GROQ_API_KEY` | — | Free Groq key from console.groq.com |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq model name |
| `OPENAI_API_KEY` | — | OpenAI key (paid) |
| `ANTHROPIC_API_KEY` | — | Anthropic key (paid) |
| `AUTO_EXECUTE_TRADES` | `false` | Set `true` to skip `--execute` flag |
| `ADMIN_API_TOKEN` | — | Bearer token for `POST /api/rebalance/execute` |
| `ORDER_VARIETY` | `regular` | `regular`, `amo`, `co`, `iceberg` |
| `ORDER_EXCHANGE` | `NSE` | `NSE` or `BSE` |
| `ORDER_PRODUCT` | `CNC` | `CNC` (delivery) or `MIS` (intraday) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

---

## Safety Notes

- **Dry-run by default**: the `rebalance` command never places orders unless `--execute` is passed.
- **CNC product**: orders default to delivery (not intraday), protecting against same-day reversals.
- **Drift threshold**: trades are only suggested when weight deviation exceeds 2% (configurable via `--drift`).
- **Sell-first ordering**: the plan always schedules SELL orders before BUY orders to free up cash.
- **Recommendations are research output only**: scores use public Yahoo/Google data; they are not brokerage research or investment advice.

---

## Development

```bash
# CLI (ts-node, no build required)
npm run dev -- rebalance --weights "INFY:30,TCS:40,HDFC:30"
npm run dev -- pnl
npm run dev -- analysis
npm run dev -- recommend --top 8
npm run dev -- holdings

# Shortcut scripts
npm run dev:rebalance
npm run dev:pnl
npm run dev:holdings
npm run dev:recommend

# API + web UI
npm run dev:server
npm run dev:web

# Debug logging
LOG_LEVEL=debug npm run dev -- pnl

# Production build
npm run build          # backend → dist/
npm run build:web      # frontend → web/dist/
npm run build:all      # both
npm run start:server   # node dist/server.js (serves API + web/dist)
npm start -- holdings  # compiled CLI
```

### npm scripts reference

| Script | Description |
|--------|-------------|
| `npm run dev` | Run CLI via ts-node (`npm run dev -- <command>`) |
| `npm run dev:server` | Express API on port 3000 |
| `npm run dev:web` | Vite React app on port 5173 |
| `npm run build` / `build:web` / `build:all` | Compile backend and/or frontend |
| `npm run start:server` | Run compiled server |
| `npm run auth` | Interactive Kite enctoken setup |
