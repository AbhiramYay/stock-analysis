// ─────────────────────────────────────────────────────────────────────────────
//  src/types/index.ts
//  Central type definitions for the Zerodha Rebalancing Agent
// ─────────────────────────────────────────────────────────────────────────────

// ─── Kite Connect Raw Types ───────────────────────────────────────────────────

/** Raw holding as returned by Kite Connect API */
export interface KiteHolding {
  tradingsymbol: string;
  exchange: string;
  isin: string;
  t1_quantity: number;
  realised_quantity: number;
  quantity: number;
  authorised_quantity: number;
  product: string;
  price: number;
  used_quantity: number;
  collateral_quantity: number;
  collateral_type: string;
  pnl: number;
  day_change: number;
  day_change_percentage: number;
  last_price: number;
  average_price: number;
  close_price: number;
}

/** Raw historical candle data from Kite Connect */
export interface KiteOHLC {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Raw order response from Kite Connect */
export interface KiteOrderResponse {
  order_id: string;
}

// ─── Domain Types ─────────────────────────────────────────────────────────────

/** Enriched holding with computed portfolio weight */
export interface Holding {
  symbol: string;
  exchange: string;
  isin: string;
  quantity: number;
  averagePrice: number;
  lastPrice: number;
  currentValue: number;
  pnl: number;
  dayChange: number;
  dayChangePercent: number;
  weight: number; // percentage of total portfolio value (0–100)
}

/** Portfolio snapshot */
export interface Portfolio {
  holdings: Holding[];
  totalValue: number;
  totalPnL: number;
  fetchedAt: Date;
}

/** Target allocation as symbol → percentage (0–100) */
export type TargetWeights = Record<string, number>;

/** A single rebalancing trade suggestion */
export interface TradeSuggestion {
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

/** Full rebalancing plan */
export interface RebalancingPlan {
  suggestions: TradeSuggestion[];
  totalBuyValue: number;
  totalSellValue: number;
  netCashRequired: number;
  weightDriftThreshold: number;
  skippedSymbols: string[]; // symbols where drift was below threshold
  generatedAt: Date;
}

// ─── PnL Types ────────────────────────────────────────────────────────────────

/** Monthly PnL for a single stock */
export interface StockMonthlyPnL {
  symbol: string;
  exchange: string;
  quantity: number;
  openPrice: number;  // price at start of last month
  closePrice: number; // price at end of last month
  currentPrice: number;
  pnlAbsolute: number;
  pnlPercent: number;
  holdingValue: number;
}

/** Aggregated monthly PnL report */
export interface MonthlyPnLReport {
  stocks: StockMonthlyPnL[];
  totalPnLAbsolute: number;
  totalPnLPercent: number;
  totalHoldingValue: number;
  bestPerformer: StockMonthlyPnL | null;
  worstPerformer: StockMonthlyPnL | null;
  period: { from: Date; to: Date };
  generatedAt: Date;
}

export type SentimentLabel = "positive" | "neutral" | "negative";
export type RiskAction =
  | "REDUCE"
  | "HOLD"
  | "CONSIDER REDUCE"
  | "CONSIDER INCREASE"
  | "INCREASE";

export type AspectRating = "positive" | "neutral" | "negative";
export interface SentimentAspects {
  earnings: AspectRating;
  guidance: AspectRating;
  management: AspectRating;
  macro: AspectRating;
}

export interface SentimentRecommendation {
  action: "buy" | "hold" | "sell";
  conviction: number;
}

export interface EnhancedSentimentResult {
  score: -1 | 0 | 1;
  overallSentiment: -1 | 0 | 1;
  label: SentimentLabel;
  confidence: number;
  themes: string[];
  keyFindings: string[];
  aspects: SentimentAspects;
  recommendation: SentimentRecommendation;
  reasoning: string;
  analystSignals: string[];
  key_phrases?: string[];
  method: "llm" | "keyword";
}

export interface StockRiskMetrics {
  symbol: string;
  sector: string;
  weight: number;
  volatilityAnnual: number;
  beta: number | null;
  averageCorrelation: number;
  topCorrelatedSymbol: string | null;
  topCorrelation: number | null;
  recentHeadlines: string[];
  sentimentScore: -1 | 0 | 1;
  sentimentLabel: SentimentLabel;
  sentimentConfidence: number;
  sentimentThemes: string[];
  sentimentAspects: SentimentAspects;
  sentimentMethod: "llm" | "keyword";
  sentimentReasoning: string;
  sentimentRecommendation: SentimentRecommendation;
  sentimentRecommendationConviction: number;
  riskOverlayNote: string;
  riskReviewRequired: boolean;
  hiddenRiskFlags: string[];
  recommendedAction: RiskAction;
}

export interface PortfolioRiskSentimentReport {
  benchmarkSymbol: string | null;
  sectorWeights: Record<string, number>;
  stockSummaries: StockRiskMetrics[];
  overallRecommendations: string[];
  riskHighlights: string[];
  generatedAt: Date;
}

// ─── Stock Recommendation Types ───────────────────────────────────────────────

export interface StockFundamentals {
  roe: number | null;
  debtToEquity: number | null;
  earningsGrowth: number | null;
  peRatio: number | null;
}

export interface StockRecommendation {
  symbol: string;
  exchange: string;
  sector: string;
  rank: number;
  compositeScore: number;
  alphaScore: number;
  fundamentalScore: number;
  sentimentScore: number;
  momentumScore: number;
  sixMonthReturnPct: number | null;
  riskScore: number;
  fundamentals: StockFundamentals;
  sentimentLabel: SentimentLabel;
  sentimentConfidence: number;
  sentimentThemes: string[];
  sentimentAspects: SentimentAspects;
  sentimentMethod: "llm" | "keyword";
  sentimentRecommendation: SentimentRecommendation;
  sentimentRecommendationConviction: number;
  recentHeadlines: string[];
  analystSignals: string[];
  fundamentalReasoning: string;
  sentimentReasoning: string;
  combinedReasoning: string;
  alphaReasoning: string;
}

export interface StockRecommendationReport {
  recommendations: StockRecommendation[];
  /** Sector weights across the recommended basket (sums to ~100). */
  sectorAllocation: Record<string, number>;
  universeScanned: number;
  candidatesPassed: number;
  dataSources: string[];
  methodology: string;
  generatedAt: Date;
}

// ─── Order Types ──────────────────────────────────────────────────────────────

export type OrderVariety = "regular" | "amo" | "co" | "iceberg";
export type OrderExchange = "NSE" | "BSE";
export type OrderProduct = "CNC" | "MIS" | "NRML";
export type OrderValidity = "DAY" | "IOC";
export type TransactionType = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "SL" | "SL-M";

/** Validated order parameters */
export interface OrderParams {
  symbol: string;
  exchange: OrderExchange;
  transactionType: TransactionType;
  quantity: number;
  orderType: OrderType;
  product: OrderProduct;
  variety: OrderVariety;
  validity: OrderValidity;
  price?: number; // required for LIMIT orders
  triggerPrice?: number; // required for SL / SL-M
}

/** Placed order result */
export interface PlacedOrder {
  orderId: string;
  symbol: string;
  transactionType: TransactionType;
  quantity: number;
  orderType: OrderType;
  status: "PLACED" | "FAILED";
  message?: string;
  placedAt: Date;
}

// ─── Agent Types ──────────────────────────────────────────────────────────────

/** CLI command input for the rebalancing agent */
export interface RebalanceInput {
  targetWeights: TargetWeights;
  dryRun: boolean;
  driftThreshold: number; // minimum % drift to trigger a trade (default 2%)
}

/** Agent execution result */
export interface AgentResult {
  success: boolean;
  command: "rebalance" | "pnl" | "analysis" | "recommend";
  portfolio?: Portfolio;
  plan?: RebalancingPlan;
  placedOrders?: PlacedOrder[];
  pnlReport?: MonthlyPnLReport;
  riskReport?: PortfolioRiskSentimentReport;
  recommendationReport?: StockRecommendationReport;
  error?: string;
  executionTimeMs: number;
}

// ─── Tool Input/Output Schemas (for LangChain tool definitions) ───────────────

export interface GetHoldingsOutput {
  holdings: Holding[];
  totalValue: number;
  totalPnL: number;
}

export interface GetHistoricalPriceInput {
  symbol: string;
  date: string; // ISO date string "YYYY-MM-DD"
}

export interface GetHistoricalPriceOutput {
  symbol: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface RebalancePortfolioInput {
  targetWeights: TargetWeights;
  driftThreshold?: number;
}

export interface PlaceOrderInput {
  symbol: string;
  transactionType: TransactionType;
  quantity: number;
  orderType?: OrderType;
  price?: number;
}

export interface PlaceOrderOutput {
  orderId: string;
  status: "PLACED" | "FAILED";
  message: string;
}
