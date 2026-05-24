'use strict';

const { test, assert } = require('./_helpers');
const { _internals } = require('../importer-core');

test('mapWithConcurrency: runs all and preserves order', async () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const results = await _internals.mapWithConcurrency(items, 3, async (n) => {
    await new Promise((r) => setTimeout(r, 5));
    return n * 10;
  });
  assert.deepStrictEqual(results, [10, 20, 30, 40, 50, 60, 70, 80]);
});

test('mapWithConcurrency: respects limit', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = new Array(20).fill(0).map((_, i) => i);
  await _internals.mapWithConcurrency(items, 4, async () => {
    inFlight++;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
  });
  assert.ok(maxInFlight <= 4, `maxInFlight=${maxInFlight} should be ≤ 4`);
  assert.ok(maxInFlight >= 2, `maxInFlight=${maxInFlight} should fan out, got too low`);
});

test('mapWithConcurrency: zero items returns []', async () => {
  const r = await _internals.mapWithConcurrency([], 4, () => 1);
  assert.deepStrictEqual(r, []);
});
