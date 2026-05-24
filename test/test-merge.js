'use strict';

const { test, assert, fakeCodexJson } = require('./_helpers');
const { parseCodexFile, mergeEntries } = require('../importer-core');

function entryFromCodex(j) {
  const r = parseCodexFile(JSON.stringify(j));
  if (r.error) throw new Error('parse failed: ' + r.error);
  return r.entry;
}

test('mergeEntries: adds brand-new entries with priorities', () => {
  const db = { providerConnections: [] };
  const entries = [
    entryFromCodex(fakeCodexJson({ email: 'a@example.com' })),
    entryFromCodex(fakeCodexJson({ email: 'b@example.com' })),
  ];
  const out = mergeEntries(db, entries);
  assert.strictEqual(out.added, 2);
  assert.strictEqual(out.refreshed, 0);
  assert.strictEqual(out.skippedOnly, 0);
  assert.strictEqual(out.skipped, 0);
  assert.deepStrictEqual(out.addedEmails.sort(), ['a@example.com', 'b@example.com']);
  assert.strictEqual(db.providerConnections.length, 2);
  assert.strictEqual(db.providerConnections[0].priority, 1);
  assert.strictEqual(db.providerConnections[1].priority, 2);
});

test('mergeEntries: refresh-on-duplicate updates tokens, preserves id', () => {
  const seed = entryFromCodex(fakeCodexJson({ email: 'dup@example.com', plan: 'free' }));
  const db = { providerConnections: [seed] };
  const seedId = seed.id;
  const seedCreatedAt = seed.createdAt;

  // Same email, but new tokens (different JWT) and a different (upgraded) plan.
  const refreshedEntry = entryFromCodex(fakeCodexJson({ email: 'dup@example.com', plan: 'plus' }));
  const out = mergeEntries(db, [refreshedEntry]);

  assert.strictEqual(out.added, 0);
  assert.strictEqual(out.refreshed, 1);
  assert.strictEqual(out.skippedOnly, 0);
  assert.strictEqual(out.skipped, 1, 'backwards-compat skipped should equal refreshed when not skip-only');
  assert.deepStrictEqual(out.refreshedEmails, ['dup@example.com']);
  assert.deepStrictEqual(out.skippedEmails, []);

  const merged = db.providerConnections[0];
  assert.strictEqual(merged.id, seedId, 'id preserved across refresh');
  assert.strictEqual(merged.createdAt, seedCreatedAt, 'createdAt preserved');
  assert.strictEqual(merged.accessToken, refreshedEntry.accessToken, 'token rotated');
  assert.strictEqual(merged.providerSpecificData.chatgptPlanType, 'plus');
});

test('mergeEntries: skip-on-duplicate without refresh leaves entry untouched', () => {
  const seed = entryFromCodex(fakeCodexJson({ email: 'keep@example.com', plan: 'free' }));
  const db = { providerConnections: [seed] };
  const seedToken = seed.accessToken;

  const dupEntry = entryFromCodex(fakeCodexJson({ email: 'keep@example.com', plan: 'plus' }));
  const out = mergeEntries(db, [dupEntry], { refreshOnDuplicate: false });

  assert.strictEqual(out.added, 0);
  assert.strictEqual(out.refreshed, 0);
  assert.strictEqual(out.skippedOnly, 1);
  assert.deepStrictEqual(out.skippedEmails, ['keep@example.com']);
  assert.strictEqual(db.providerConnections[0].accessToken, seedToken, 'token NOT rotated');
  assert.strictEqual(db.providerConnections[0].providerSpecificData.chatgptPlanType, 'free');
});

test('mergeEntries: dedupes by accessToken too (different email reuse)', () => {
  const seed = entryFromCodex(fakeCodexJson({ email: 'orig@example.com' }));
  const db = { providerConnections: [seed] };

  // Build a clone with the SAME accessToken but a different email — this
  // happens when the same Codex login is exported twice with metadata
  // changes. mergeEntries should treat it as a duplicate.
  const clone = { ...seed, id: 'different-id', email: 'alias@example.com', name: 'alias@example.com' };
  // Tweak refreshToken so we know which side won.
  clone.refreshToken = clone.refreshToken + '_v2';
  const out = mergeEntries(db, [clone]);

  assert.strictEqual(out.added, 0);
  assert.strictEqual(out.refreshed, 1);
  assert.strictEqual(db.providerConnections.length, 1);
  assert.strictEqual(db.providerConnections[0].refreshToken, clone.refreshToken);
});

test('mergeEntries: priority increments per-batch', () => {
  const db = { providerConnections: [] };
  const entries = [];
  for (let i = 0; i < 5; i++) {
    entries.push(entryFromCodex(fakeCodexJson({ email: `u${i}@example.com` })));
  }
  mergeEntries(db, entries);
  const priorities = db.providerConnections.map((e) => e.priority);
  assert.deepStrictEqual(priorities, [1, 2, 3, 4, 5]);
});
