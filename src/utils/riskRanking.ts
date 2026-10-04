import type { RiskAction, RiskPriorityRank } from "../types";

export interface RiskRankableSummary {
  symbol: string;
  recommendedAction: RiskAction;
  benchmarkRelativeReturnPct: number | null;
  sentimentScore: -1 | 0 | 1;
  sentimentConfidence: number;
  sentimentRecommendationConviction: number;
  volatilityAnnual: number;
  beta: number | null;
  averageCorrelation: number;
  weight: number;
  sectorWeightPct: number;
  hiddenRiskFlags: string[];
}

const ACTION_PRIORITY: Record<RiskAction, RiskPriorityRank> = {
  INCREASE: 1,
  "CONSIDER INCREASE": 1,
  REDUCE: 2,
  "CONSIDER REDUCE": 2,
  HOLD: 3,
};

const ACTION_STRENGTH: Record<RiskAction, number> = {
  INCREASE: 0,
  "CONSIDER INCREASE": 1,
  REDUCE: 0,
  "CONSIDER REDUCE": 1,
  HOLD: 0,
};

export function getRiskPriorityRank(action: RiskAction): RiskPriorityRank {
  return ACTION_PRIORITY[action];
}

/** Convert a metric to a 0-100 percentile within the current priority group. */
function percentileScores<T>(
  rows: T[],
  getValue: (row: T) => number | null,
  higherIsBetter: boolean
): number[] {
  const values = rows.map(getValue);
  const available = values.filter((value): value is number => value !== null && Number.isFinite(value));

  return values.map((value) => {
    if (value === null || !Number.isFinite(value) || available.length <= 1) return 50;
    const lower = available.filter((candidate) => candidate < value).length;
    const equal = available.filter((candidate) => candidate === value).length;
    const percentile = ((lower + (equal - 1) / 2) / (available.length - 1)) * 100;
    return higherIsBetter ? percentile : 100 - percentile;
  });
}

function weightedScore(parts: Array<[number[], number]>, index: number): number {
  return parts.reduce((total, [scores, weight]) => total + scores[index] * weight, 0);
}

function scorePriorityGroup<T extends RiskRankableSummary>(rows: T[], priorityRank: RiskPriorityRank): number[] {
  const pct = (getValue: (row: T) => number | null, higherIsBetter: boolean) =>
    percentileScores(rows, getValue, higherIsBetter);
  const relativeReturn = pct((row) => row.benchmarkRelativeReturnPct, priorityRank !== 2);
  const volatility = pct((row) => row.volatilityAnnual, priorityRank !== 1 && priorityRank !== 3);
  const beta = pct((row) => row.beta, priorityRank === 2);
  const correlation = pct((row) => Math.abs(row.averageCorrelation), priorityRank === 2);
  const holdingWeight = pct((row) => row.weight, priorityRank === 2);
  const sectorWeight = pct((row) => row.sectorWeightPct, priorityRank === 2);
  const riskFlags = pct((row) => row.hiddenRiskFlags.length, priorityRank === 2);

  if (priorityRank === 1) {
    const positiveConviction = pct(
      (row) => row.sentimentScore > 0
        ? row.sentimentConfidence * row.sentimentRecommendationConviction
        : 0,
      true
    );
    return rows.map((_, index) => weightedScore([
      [relativeReturn, 0.30],
      [positiveConviction, 0.25],
      [volatility, 0.15],
      [beta, 0.10],
      [correlation, 0.08],
      [holdingWeight, 0.05],
      [sectorWeight, 0.04],
      [riskFlags, 0.03],
    ], index));
  }

  if (priorityRank === 2) {
    const negativeConviction = pct(
      (row) => row.sentimentScore < 0
        ? row.sentimentConfidence * row.sentimentRecommendationConviction
        : 0,
      true
    );
    return rows.map((_, index) => weightedScore([
      [relativeReturn, 0.25],
      [negativeConviction, 0.25],
      [volatility, 0.15],
      [beta, 0.10],
      [correlation, 0.10],
      [holdingWeight, 0.05],
      [sectorWeight, 0.05],
      [riskFlags, 0.05],
    ], index));
  }

  const neutralSentiment = pct((row) => 1 - Math.abs(row.sentimentScore), true);
  return rows.map((_, index) => weightedScore([
    [volatility, 0.35],
    [beta, 0.15],
    [correlation, 0.10],
    [holdingWeight, 0.15],
    [sectorWeight, 0.10],
    [neutralSentiment, 0.10],
    [relativeReturn, 0.05],
  ], index));
}

/**
 * Scores each stock relative to others in the same action-priority group, then
 * gives it a 1-based position within that group. Percentile scores make the
 * different measurements comparable; unavailable measurements are neutral.
 */
export function rankRiskSummaries<T extends RiskRankableSummary>(
  summaries: T[]
): Array<T & { priorityRank: RiskPriorityRank; categoryRank: number; rankingScore: number }> {
  const groups = new Map<RiskPriorityRank, T[]>();
  for (const summary of summaries) {
    const priority = getRiskPriorityRank(summary.recommendedAction);
    groups.set(priority, [...(groups.get(priority) ?? []), summary]);
  }

  const ranked: Array<T & { priorityRank: RiskPriorityRank; categoryRank: number; rankingScore: number }> = [];
  for (const priorityRank of [1, 2, 3] as const) {
    const group = groups.get(priorityRank) ?? [];
    const scores = scorePriorityGroup(group, priorityRank);
    const ordered = group
      .map((summary, index) => ({ summary, score: scores[index] }))
      .sort((a, b) =>
        b.score - a.score ||
        ACTION_STRENGTH[a.summary.recommendedAction] - ACTION_STRENGTH[b.summary.recommendedAction] ||
        a.summary.symbol.localeCompare(b.summary.symbol)
      );

    ordered.forEach(({ summary, score }, index) => {
      ranked.push({
        ...summary,
        priorityRank,
        categoryRank: index + 1,
        rankingScore: Number(score.toFixed(1)),
      });
    });
  }

  return ranked;
}
