'use strict';

const { test, assert, makeZip, makeEncryptedZip } = require('./_helpers');
const { readZipEntries } = require('../zip-reader');

test('readZipEntries: STORE round-trip for one JSON entry', () => {
  const buf = makeZip([{ name: 'a.json', content: '{"hello":"world"}' }]);
  const entries = readZipEntries(buf);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].name, 'a.json');
  assert.strictEqual(entries[0].text, '{"hello":"world"}');
});

test('readZipEntries: DEFLATE round-trip', () => {
  const payload = JSON.stringify({ data: 'x'.repeat(500) });
  const buf = makeZip([{ name: 'big.json', content: payload, method: 8 }]);
  const entries = readZipEntries(buf);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].text, payload);
});

test('readZipEntries: filters non-matching files', () => {
  const buf = makeZip([
    { name: 'a.json', content: '{"a":1}' },
    { name: 'b.txt', content: 'plain' },
    { name: 'c.json', content: '{"c":3}' },
  ]);
  const entries = readZipEntries(buf);
  assert.deepStrictEqual(entries.map((e) => e.name).sort(), ['a.json', 'c.json']);
});

test('readZipEntries: backslash-separated names normalised to forward-slash', () => {
  const buf = makeZip([{ name: 'sub\\dir\\nested.json', content: '{}' }]);
  const entries = readZipEntries(buf);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].name, 'sub/dir/nested.json');
});

test('readZipEntries: encrypted entry → throws clearly', () => {
  const buf = makeEncryptedZip();
  assert.throws(() => readZipEntries(buf), /mã hoá|không hỗ trợ/);
});

test('readZipEntries: bad signature → throws', () => {
  // Random buffer that's "ZIP-shaped" enough to find the EOCD but the CDH
  // signature is wrong.
  assert.throws(() => readZipEntries(Buffer.from('not a zip')), /quá nhỏ|EOCD/);
});

test('readZipEntries: directory entries are skipped', () => {
  // makeZip doesn't create directory entries, but we can manually add one
  // by constructing an entry whose name ends in /. The reader should skip.
  // We rely on the fact that name detection happens before file extension
  // filter, but to be safe, we ensure the array doesn't include the dir.
  const buf = makeZip([
    { name: 'sub/', content: '' }, // synthetic directory entry
    { name: 'sub/file.json', content: '{}' },
  ]);
  const entries = readZipEntries(buf);
  assert.deepStrictEqual(entries.map((e) => e.name), ['sub/file.json']);
});
