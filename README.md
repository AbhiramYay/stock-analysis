# 🏦 Zerodha Portfolio Rebalancing Agent

A production-ready TypeScript agent that uses **LangChain.js** and **Zerodha Kite Connect API** to analyse your equity portfolio, generate rebalancing trade suggestions, and optionally execute them — all from the command line.

---

## Architecture

```
zerodha-rebalancer/
├── src/
│   ├── agents/
│   │   └── rebalancingAgent.ts   # LangChain ReAct agent + rebalance/PnL orchestrators
│   ├── tools/                    # Kite API calls wrapped as LangChain MCP tools
│   │   ├── getHoldings.ts        # Fetch & enrich current portfolio
│   │   ├── getHistoricalPrice.ts # OHLCV data for any symbol/date
│   │   ├── rebalancePortfolio.ts # Weight diff → trade suggestions
│   │   ├── riskSentiment.ts      # Risk, volatility, beta, correlation, and news sentiment analysis
│   │   └── placeOrder.ts         # Execute BUY/SELL orders
│   ├── utils/
│   │   ├── kiteClient.ts         # Singleton KiteConnect client + API wrappers
│   │   ├── pnl.ts                # calculateMonthlyPnL + formatters
│   │   ├── display.ts            # Rich terminal tables (chalk + table)
│   │   └── logger.ts             # Winston structured logger
│   ├── types/
│   │   └── index.ts              # All TypeScript interfaces & types
│   └── cli.ts                    # Commander.js CLI entry point
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Node.js ≥ 18 | [nodejs.org](https://nodejs.org) |
| Zerodha account | Regular login at [kite.zerodha.com](https://kite.zerodha.com) — no API subscription needed |
| OpenAI API key (or Anthropic) | For the LLM agent — [platform.openai.com](https://platform.openai.com) |

---

## Setup

### 1. Clone & install

```bash
git clone <repo>
cd zerodha-rebalancer
npm install
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
npm run dev -- pnl
```

---

### `analysis` — Portfolio risk and sentiment analysis

```bash
npm run dev -- analysis
```

```bash
npm run dev -- analysis --lookback 120
```

This command analyses your holdings for volatility, beta, sector concentration, and recent news sentiment, then recommends whether to hold, reduce, or consider increasing exposure.

---

**Sample Output:**

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
```

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
```

---

## MCP Tools

The four LangChain tools wrap Kite API calls:

| Tool | Input | What it does |
|------|-------|--------------|
| `getHoldings` | — | Fetch live portfolio, compute weights |
| `getHistoricalPrice` | symbol, date, exchange | OHLCV data for any date |
| `rebalancePortfolio` | targetWeights, driftThreshold | Compute BUY/SELL suggestions |
| `riskSentiment` | lookbackDays | Compute volatility, beta, sector correlation, and sentiment-based adjustments |
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

---

## Development

```bash
# Run directly with ts-node (no build needed)
npm run dev -- rebalance --weights "INFY:30,TCS:40,HDFC:30"

# With debug logging
LOG_LEVEL=debug npm run dev -- pnl

# Build to dist/
npm run build

# Run compiled version
npm start -- holdings
```
