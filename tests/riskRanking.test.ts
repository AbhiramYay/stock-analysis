import test from "node:test";
import assert from "node:assert/strict";
import { getRiskPriorityRank, rankRiskSummaries } from "../src/utils/riskRanking";
import type { RiskAction } from "../src/types";
import type { RiskRankableSummary } from "../src/utils/riskRanking";

function summary(
  symbol: string,
  recommendedAction: RiskAction,
  overrides: Partial<RiskRankableSummary> = {}
): RiskRankableSummary {
  return {
    symbol,
    recommendedAction,
    benchmarkRelativeReturnPct: 0,
    sentimentScore: 0,
    sentimentConfidence: 0.5,
    sentimentRecommendationConviction: 0.5,
    volatilityAnnual: 20,
    beta: 1,
    averageCorrelation: 0.5,
    weight: 10,
    sectorWeightPct: 20,
    hiddenRiskFlags: [],
    ...overrides,
  };
}

test("getRiskPriorityRank maps the five actions to the requested priority groups", () => {
  const expected: Array<[RiskAction, 1 | 2 | 3]> = [
    ["INCREASE", 1],
    ["CONSIDER INCREASE", 1],
    ["REDUCE", 2],
    ["CONSIDER REDUCE", 2],
    ["HOLD", 3],
  ];

  for (const [action, rank] of expected) {
    assert.equal(getRiskPriorityRank(action), rank);
  }
});

test("Priority 1 ranks stronger benchmark performance and conviction first", () => {
  const ranked = rankRiskSummaries([
    summary("WEAKER", "INCREASE", {
      benchmarkRelativeReturnPct: -4,
      sentimentScore: 1,
      sentimentConfidence: 0.4,
      sentimentRecommendationConviction: 0.4,
      volatilityAnnual: 35,
      beta: 1.5,
      averageCorrelation: 0.9,
      weight: 25,
      sectorWeightPct: 45,
      hiddenRiskFlags: ["high beta", "sector concentration"],
    }),
    summary("STRONGER", "CONSIDER INCREASE", {
      benchmarkRelativeReturnPct: 8,
      sentimentScore: 1,
      sentimentConfidence: 0.9,
      sentimentRecommendationConviction: 0.9,
      volatilityAnnual: 12,
      beta: 0.8,
      averageCorrelation: 0.2,
      weight: 5,
      sectorWeightPct: 15,
    }),
  ]);

  assert.deepEqual(ranked.map(({ symbol, categoryRank }) => [symbol, categoryRank]), [
    ["STRONGER", 1],
    ["WEAKER", 2],
  ]);
  assert.ok(ranked[0].rankingScore > ranked[1].rankingScore);
  assert.ok(ranked.every((row) => row.priorityRank === 1));
});

test("Priority 2 ranks the most underperforming, risk-flagged reductions first", () => {
  const ranked = rankRiskSummaries([
    summary("MILD", "CONSIDER REDUCE", {
      benchmarkRelativeReturnPct: -1,
      sentimentScore: -1,
      sentimentConfidence: 0.4,
      sentimentRecommendationConviction: 0.5,
      volatilityAnnual: 15,
      beta: 0.9,
      averageCorrelation: 0.2,
      weight: 5,
      sectorWeightPct: 15,
    }),
    summary("URGENT", "REDUCE", {
      benchmarkRelativeReturnPct: -12,
      sentimentScore: -1,
      sentimentConfidence: 0.95,
      sentimentRecommendationConviction: 0.9,
      volatilityAnnual: 40,
      beta: 1.6,
      averageCorrelation: 0.95,
      weight: 30,
      sectorWeightPct: 50,
      hiddenRiskFlags: ["high beta", "concentration"],
    }),
  ]);

  assert.deepEqual(ranked.map(({ symbol, categoryRank }) => [symbol, categoryRank]), [
    ["URGENT", 1],
    ["MILD", 2],
  ]);
  assert.ok(ranked[0].rankingScore > ranked[1].rankingScore);
});

test("Priority 3 ranks lower-risk and less concentrated holdings first", () => {
  const ranked = rankRiskSummaries([
    summary("RISKIER", "HOLD", {
      volatilityAnnual: 35,
      beta: 1.5,
      averageCorrelation: 0.9,
      weight: 25,
      sectorWeightPct: 45,
    }),
    summary("STABLE", "HOLD", {
      benchmarkRelativeReturnPct: 2,
      volatilityAnnual: 10,
      beta: 0.8,
      averageCorrelation: 0.2,
      weight: 5,
      sectorWeightPct: 15,
    }),
  ]);

  assert.deepEqual(ranked.map(({ symbol, categoryRank }) => [symbol, categoryRank]), [
    ["STABLE", 1],
    ["RISKIER", 2],
  ]);
});

test("category ranks restart per priority; unavailable performance is handled neutrally", () => {
  const ranked = rankRiskSummaries([
    summary("HOLDING", "HOLD", { benchmarkRelativeReturnPct: null }),
    summary("SELLING", "REDUCE", { benchmarkRelativeReturnPct: null }),
    summary("BUYING", "INCREASE", { benchmarkRelativeReturnPct: null }),
  ]);

  assert.deepEqual(ranked.map(({ symbol, priorityRank, categoryRank }) => [symbol, priorityRank, categoryRank]), [
    ["BUYING", 1, 1],
    ["SELLING", 2, 1],
    ["HOLDING", 3, 1],
  ]);
});
