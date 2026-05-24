'use strict';

const { test, assert, fakeCodexJson } = require('./_helpers');
const { parseUploads } = require('../importer-core');

test('parseUploads: strips accessToken from rows', async () => {
  const rows = await parseUploads(
    [
      { name: 'a.json', text: JSON.stringify(fakeCodexJson({ email: 'a@example.com' })) },
      { name: 'b.json', text: JSON.stringify(fakeCodexJson({ email: 'b@example.com' })) },
    ],
    { verifyPlanOnline: false }
  );
  assert.strictEqual(rows.length, 2);
  for (const r of rows) {
    assert.ok(!r.error, r.error);
    assert.ok(r.source && r.source.email);
    assert.strictEqual(r.source.accessToken, undefined, 'accessToken must NOT leak to caller');
    assert.strictEqual(r.source.planSource, 'jwt_only');
  }
});

test('parseUploads: returns one row per parse error', async () => {
  const rows = await parseUploads(
    [
      { name: 'good.json', text: JSON.stringify(fakeCodexJson({ email: 'g@example.com' })) },
      { name: 'broken.json', text: '{not json' },
      { name: 'empty.json', text: '{}' },
    ],
    { verifyPlanOnline: false }
  );
  assert.strictEqual(rows.length, 3);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.ok(!byName['good.json'].error);
  assert.ok(byName['broken.json'].error);
  assert.ok(byName['empty.json'].error);
});

test('parseUploads: surfaces ZIP errors before parsing', async () => {
  // Send a buffer that is not a valid zip, base64-encoded.
  const fakeZip = Buffer.from('not a zip').toString('base64');
  const rows = await parseUploads(
    [{ name: 'bad.zip', zip: fakeZip }],
    { verifyPlanOnline: false }
  );
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].error && /ZIP/i.test(rows[0].error));
});
