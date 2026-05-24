'use strict';

const { test, assert, fakeCodexJson, fakeJwt } = require('./_helpers');
const { parseCodexFile, decodeJwtPayload, _internals } = require('../importer-core');

test('parseCodexFile: flat creds → entry with email + plan from JWT', () => {
  const json = fakeCodexJson({ email: 'alice@example.com', plan: 'plus' });
  const r = parseCodexFile(JSON.stringify(json));
  assert.ok(!r.error, 'no error');
  assert.strictEqual(r.entry.provider, 'codex');
  assert.strictEqual(r.entry.email, 'alice@example.com');
  assert.strictEqual(r.entry.name, 'alice@example.com');
  assert.strictEqual(r.entry.providerSpecificData.chatgptPlanType, 'plus');
  assert.strictEqual(r.source.email, 'alice@example.com');
  assert.strictEqual(r.source.chatgptPlanType, 'plus');
  assert.ok(typeof r.source.refreshTail === 'string' && r.source.refreshTail.length === 8);
  // accessToken should be in source for verification but stripped before
  // it leaves bulkImport / parseUploads.
  assert.ok(typeof r.source.accessToken === 'string');
});

test('parseCodexFile: array of credentials picks the first', () => {
  const arr = [fakeCodexJson({ email: 'first@example.com' }), fakeCodexJson({ email: 'second@example.com' })];
  const r = parseCodexFile(JSON.stringify(arr));
  assert.ok(!r.error);
  assert.strictEqual(r.source.email, 'first@example.com');
});

test('parseCodexFile: accounts[] wrapper picks the openai account', () => {
  const codex = fakeCodexJson({ email: 'wrap@example.com', plan: 'team' });
  const wrapped = {
    exported_at: new Date().toISOString(),
    accounts: [
      { platform: 'unrelated', credentials: { foo: 'bar' } },
      {
        platform: 'openai',
        name: 'wrap@example.com',
        credentials: {
          access_token: codex.access_token,
          refresh_token: codex.refresh_token,
          id_token: codex.id_token,
          chatgpt_account_id: codex.account_id,
        },
        extra: { email: 'wrap@example.com' },
      },
    ],
  };
  const r = parseCodexFile(JSON.stringify(wrapped));
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.source.email, 'wrap@example.com');
  assert.strictEqual(r.source.chatgptPlanType, 'team');
});

test('parseCodexFile: tokens-wrapper (Codex CLI auth.json) is flattened', () => {
  const codex = fakeCodexJson({ email: 'cli@example.com', plan: 'pro' });
  const wrapper = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      access_token: codex.access_token,
      refresh_token: codex.refresh_token,
      id_token: codex.id_token,
      account_id: codex.account_id,
    },
    last_refresh: '2026-05-22T20:53:26Z',
  };
  const r = parseCodexFile(JSON.stringify(wrapper));
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.source.email, 'cli@example.com');
  assert.strictEqual(r.source.chatgptPlanType, 'pro');
});

test('parseCodexFile: invalid JSON → error', () => {
  const r = parseCodexFile('{not json');
  assert.ok(r.error && /JSON/.test(r.error));
});

test('parseCodexFile: missing access_token → error', () => {
  const r = parseCodexFile(JSON.stringify({ refresh_token: 'x' }));
  assert.ok(r.error && /access_token/.test(r.error));
});

test('parseCodexFile: missing refresh_token → error', () => {
  const r = parseCodexFile(JSON.stringify({ access_token: 'x' }));
  assert.ok(r.error && /refresh_token/.test(r.error));
});

test('parseCodexFile: empty array → error', () => {
  const r = parseCodexFile('[]');
  assert.ok(r.error && /rỗng/.test(r.error));
});

test('parseCodexFile: BOM + leading whitespace are tolerated', () => {
  const json = fakeCodexJson({ email: 'bom@example.com' });
  const text = '\uFEFF  \r\n' + JSON.stringify(json) + '  \n';
  const r = parseCodexFile(text);
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.source.email, 'bom@example.com');
});

test('parseCodexFile: tokens with surrounding whitespace are trimmed', () => {
  const json = fakeCodexJson({ email: 'ws@example.com' });
  json.access_token = '\r\n  ' + json.access_token + '  \r\n';
  json.refresh_token = '\uFEFF' + json.refresh_token + '\n';
  const r = parseCodexFile(JSON.stringify(json));
  assert.ok(!r.error, r.error);
  // The cleaned tokens should still decode properly — i.e. plan was read
  // from the JWT, not defaulted to "free".
  assert.strictEqual(r.source.email, 'ws@example.com');
});

test('parseCodexFile: falls back to top-level email when JWT has none', () => {
  const codex = fakeCodexJson({ email: 'jwt@example.com', plan: 'free' });
  // Strip the profile claim from id_token by replacing with a JWT that has
  // no profile.email — but keep account_id in the auth claim.
  codex.id_token = fakeJwt({
    'https://api.openai.com/auth': {
      chatgpt_account_id: codex.account_id,
      chatgpt_plan_type: 'free',
    },
  });
  codex.email = 'fallback@example.com';
  const r = parseCodexFile(JSON.stringify(codex));
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.source.email, 'fallback@example.com');
});

test('decodeJwtPayload: round-trip', () => {
  const payload = { foo: 'bar', n: 42, arr: [1, 2] };
  const jwt = fakeJwt(payload);
  const decoded = decodeJwtPayload(jwt);
  assert.deepStrictEqual(decoded, payload);
});

test('decodeJwtPayload: missing parts → null', () => {
  assert.strictEqual(decodeJwtPayload('only-one-segment'), null);
  assert.strictEqual(decodeJwtPayload(''), null);
  assert.strictEqual(decodeJwtPayload(null), null);
  assert.strictEqual(decodeJwtPayload(undefined), null);
});

test('decodeJwtPayload: invalid base64 → null', () => {
  assert.strictEqual(decodeJwtPayload('xxx.@@@.yyy'), null);
});

test('flattenCodexShape: recognises wrappers without recursion', () => {
  const codex = fakeCodexJson({ email: 'flat@example.com' });
  const r = _internals.flattenCodexShape({ tokens: codex });
  assert.ok(r.flat);
  assert.strictEqual(r.flat.email, 'flat@example.com');
});

test('stripBom: removes leading U+FEFF only', () => {
  assert.strictEqual(_internals.stripBom('\uFEFFhello'), 'hello');
  assert.strictEqual(_internals.stripBom('hello'), 'hello');
  assert.strictEqual(_internals.stripBom(''), '');
});
