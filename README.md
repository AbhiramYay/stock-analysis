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

| Requirement | Version |
|-------------|---------|
| Node.js | ≥ 18.0 |
| Zerodha Kite Connect subscription | [developers.kite.trade](https://developers.kite.trade) |
| OpenAI API key (or Anthropic) | For the LLM agent |

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
# Zerodha Kite Connect
KITE_API_KEY=your_api_key
KITE_API_SECRET=your_api_secret
KITE_ACCESS_TOKEN=your_access_token   # generated via Kite login flow

# LLM (openai or anthropic)
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o

# Optional: set to "true" to auto-execute trades without --execute flag
AUTO_EXECUTE_TRADES=false
```

### 3. Generate Kite Access Token

The access token expires daily. Use the Kite Connect login flow:

```bash
# Open the auth URL in your browser:
# https://kite.trade/connect/login?api_key=YOUR_KEY&v=3
# After login, copy the request_token from the redirect URL
# Then generate access_token:

node -e "
const { KiteConnect } = require('kiteconnect');
const kite = new KiteConnect({ api_key: 'YOUR_API_KEY' });
kite.generateSession('REQUEST_TOKEN', 'YOUR_API_SECRET').then(s => {
  console.log('access_token:', s.access_token);
});
"
```

### 4. Build

```bash
npm run build
# Output: dist/
```

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

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `KITE_API_KEY` | — | Kite Connect API key (required) |
| `KITE_ACCESS_TOKEN` | — | Daily access token (required) |
| `LLM_PROVIDER` | `openai` | `openai` or `anthropic` |
| `OPENAI_MODEL` | `gpt-4o` | Any GPT-4 class model |
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
