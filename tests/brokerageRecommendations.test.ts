import test from 'node:test';
import assert from 'node:assert/strict';
import { filterBuyRecommendations, normalizeBrokerageRecommendations } from '../src/tools/brokerageRecommendations';

test('normalizeBrokerageRecommendations converts scraped rows into a standard JSON shape', () => {
  const normalized = normalizeBrokerageRecommendations([
    { stock: 'Reliance', brokerage: 'ICICI Direct', recommendation: 'Buy', targetPrice: '1250' },
    { stock: 'Tata Steel', brokerage: 'Motilal Oswal', recommendation: 'Hold', targetPrice: '140' },
  ]);

  assert.deepEqual(normalized, [
    { stock: 'Reliance', brokerage: 'ICICI Direct', recommendation: 'Buy', targetPrice: 1250 },
    { stock: 'Tata Steel', brokerage: 'Motilal Oswal', recommendation: 'Hold', targetPrice: 140 },
  ]);
});

test('filterBuyRecommendations keeps only buy calls that meet the upside threshold', () => {
  const filtered = filterBuyRecommendations(
    [
      { stock: 'RELIANCE', brokerage: 'ICICI Direct', recommendation: 'Buy', targetPrice: 1250 },
      { stock: 'IRCTC', brokerage: 'Motilal Oswal', recommendation: 'Buy', targetPrice: 780 },
      { stock: 'HCLTECH', brokerage: 'Geojit', recommendation: 'Sell', targetPrice: 1600 },
    ],
    {
      currentPrices: {
        RELIANCE: 1100,
        IRCTC: 700,
      },
      minUpsidePct: 10,
    }
  );

  assert.deepEqual(filtered, [
    { stock: 'RELIANCE', brokerage: 'ICICI Direct', recommendation: 'Buy', targetPrice: 1250 },
    { stock: 'IRCTC', brokerage: 'Motilal Oswal', recommendation: 'Buy', targetPrice: 780 },
  ]);
});
