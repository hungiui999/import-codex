'use strict';

/*
 * Tiny test helpers — no dependencies, just node:assert plus a few utilities
 * for fake JWTs, fake ZIPs, and a temp HOME for testing ensureConfigToml.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const REGISTRY = [];

function test(name, fn) {
  REGISTRY.push({ name, fn });
}

async function runAll() {
  let passed = 0;
  let failed = 0;
  const failures = [];
  for (const { name, fn } of REGISTRY) {
    try {
      const out = fn();
      if (out && typeof out.then === 'function') await out;
      console.log(`  ok  ${name}`);
      passed++;
    } catch (e) {
      console.log(`  FAIL ${name}`);
      console.log('       ' + (e.stack || e.message).split('\n').join('\n       '));
      failed++;
      failures.push({ name, err: e });
    }
  }
  console.log('');
  console.log(`Tổng: ${passed + failed} test, ${passed} pass, ${failed} fail.`);
  if (failed > 0) {
    process.exitCode = 1;
  }
  return { passed, failed, failures };
}

// Build a fake JWT (no signature verification). `payload` is the JSON object
// to embed in the second segment.
function fakeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.SIGNATURE_PLACEHOLDER`;
}

// Create a complete Codex/ChatGPT credentials JSON object. Only the access
// and refresh tokens are returned as REAL JWT structures (with placeholder
// signatures) — never write real tokens here.
//
// `accountId` defaults to a fresh UUID per call so that two fake credentials
// don't accidentally share the same access token.
let __fakeAccountIdSeq = 0;
function fakeCodexJson({
  email = 'test@example.com',
  plan = 'free',
  accountId = null,
  extra = {},
} = {}) {
  if (!accountId) {
    __fakeAccountIdSeq++;
    const hex = String(__fakeAccountIdSeq).padStart(12, '0');
    accountId = `00000000-0000-0000-0000-${hex}`;
  }
  const idToken = fakeJwt({
    'https://api.openai.com/profile': { email, email_verified: true },
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: plan,
    },
  });
  const accessToken = fakeJwt({
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: plan,
    },
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
  });
  const refreshToken = 'eyJREDACTED.REFRESH.PLACEHOLDER_' + accountId.slice(0, 8);
  return {
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken,
    account_id: accountId,
    last_refresh: '2026-05-22T20:53:26Z',
    email,
    type: 'codex',
    expired: '2026-06-01T20:53:27Z',
    ...extra,
  };
}

// Build an in-memory ZIP archive with the given entries.
//   entries = [{ name, content, method? }]   method: 0=store, 8=deflate (default 0)
function makeZip(entries) {
  const zlib = require('zlib');
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method == null ? 0 : e.method;
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.from(e.content, 'utf8');
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(0, 14); // crc placeholder (reader doesn't validate)
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(0, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdData = Buffer.concat(central);
  const cdOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdData.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cdData, eocd]);
}

// Build an encrypted-flag ZIP entry (we only need the local header flag set;
// the reader checks the flag, not real encryption).
function makeEncryptedZip() {
  const z = makeZip([{ name: 'secret.json', content: '{}' }]);
  // Set the "encrypted" bit (0x0001) in the local file header flags field.
  // Local header flags is at offset 6 of the local file header (which is at
  // byte 0). We then re-emit the central header to keep it consistent for
  // robust readers, but our reader only inspects the local header flag.
  z.writeUInt16LE(0x0001, 6);
  return z;
}

// Run a callback with os.homedir() temporarily pointing at a fresh temp dir.
// Restores the original homedir + env vars on exit.
function withFakeHome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '9router-test-'));
  const origHome = os.homedir;
  const origEnv = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
  };
  os.homedir = () => tmp;
  process.env.USERPROFILE = tmp;
  process.env.HOME = tmp;
  try {
    const r = fn(tmp);
    if (r && typeof r.then === 'function') {
      return r.finally(() => restore());
    }
    restore();
    return r;
  } catch (e) {
    restore();
    throw e;
  }
  function restore() {
    os.homedir = origHome;
    if (origEnv.USERPROFILE !== undefined) process.env.USERPROFILE = origEnv.USERPROFILE;
    else delete process.env.USERPROFILE;
    if (origEnv.HOME !== undefined) process.env.HOME = origEnv.HOME;
    else delete process.env.HOME;
    try {
      rmrf(tmp);
    } catch (_) { /* ignore */ }
  }
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (_) {
    // node <14 fallback
  }
}

module.exports = {
  test,
  runAll,
  assert,
  fakeJwt,
  fakeCodexJson,
  makeZip,
  makeEncryptedZip,
  withFakeHome,
  rmrf,
};
