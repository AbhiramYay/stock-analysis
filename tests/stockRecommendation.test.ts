import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRecommendationUniverse } from '../src/tools/stockRecommendation';
import { getFallbackSymbolSeeds, normalizeDiscoveredSymbols } from '../src/utils/yahooClient';

test('normalizeDiscoveredSymbols strips Yahoo suffixes and removes duplicates', () => {
  const normalized = normalizeDiscoveredSymbols(['RELIANCE.NS', 'TCS.NS', 'RELIANCE.NS', 'SBIN.BO']);
  assert.deepEqual(normalized, ['RELIANCE', 'TCS', 'SBIN']);
});

test('getFallbackSymbolSeeds returns a broad seed set when Yahoo search fails', () => {
  const seeds = getFallbackSymbolSeeds();
  assert.ok(seeds.includes('RELIANCE'));
  assert.ok(seeds.includes('ADANIENT'));
  assert.ok(seeds.includes('IRCTC'));
  assert.ok(seeds.length >= 40);
});

test('resolveRecommendationUniverse returns a multicap basket for multicap scope', async () => {
  const universe = await resolveRecommendationUniverse({ scope: 'multicap', includeHoldings: false });
  assert.ok(universe.length > 0);
});

test('resolveRecommendationUniverse keeps the Nifty 50 scope for classic recommendations', async () => {
  const universe = await resolveRecommendationUniverse({ scope: 'nifty', includeHoldings: false });
  assert.ok(universe.includes('RELIANCE'));
  assert.ok(universe.includes('TCS'));
  assert.ok(universe.includes('INFY'));
  assert.ok(universe.length <= 50);
});
