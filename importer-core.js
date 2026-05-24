'use strict';

/*
 * Core logic for the 9router ChatGPT/Codex bulk importer.
 *
 * Pure / side-effect-isolated helpers. No npm dependencies — only Node core.
 *
 * Public API:
 *   expandInputs(inputs)               -> string[]   (recursively expand files/dirs to *.json)
 *   decodeJwtPayload(jwt)              -> object|null
 *   parseCodexFile(jsonText)           -> { entry?, error?, source }
 *   is9routerRunning(baseUrl)          -> Promise<boolean>
 *   stop9router({log})                 -> Promise<{stopped: boolean, killedPids: number[]}>
 *   start9router({log})                -> Promise<{started: boolean, pid?: number}>
 *   loadDb(path)                       -> object
 *   saveDb(path, db)                   -> void   (atomic write via tmp+rename)
 *   backupDb(path)                     -> string|null   (path of the backup or null if no db)
 *   mergeEntries(db, entries, opts)    -> { added, skipped, addedEmails, skippedEmails }
 *   bulkImport({inputs, dbPath, forceStop, dryRun, noRestart, log}) -> result obj
 *
 * NOTE: never log full tokens. The CLI / GUI may show only the email and the
 * last 8 chars of the refresh token.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const { randomUUID } = require('crypto');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'http://127.0.0.1:20128';
const APPDATA_9ROUTER = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  '9router'
);
const DEFAULT_SQLITE_PATH = path.join(APPDATA_9ROUTER, 'db', 'data.sqlite');
const DEFAULT_JSON_PATH = path.join(APPDATA_9ROUTER, 'db.json');
// "DB path" can refer to either the SQLite file or the legacy JSON file.
// We pick whichever actually exists; SQLite wins when both are present.
const DEFAULT_DB_PATH = fs.existsSync(DEFAULT_SQLITE_PATH)
  ? DEFAULT_SQLITE_PATH
  : DEFAULT_JSON_PATH;
const NINER_CLI = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'npm',
  'node_modules',
  '9router',
  'cli.js'
);
const NINER_BETTER_SQLITE = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  '9router',
  'runtime',
  'node_modules',
  'better-sqlite3'
);
const NODE_EXE = process.execPath; // current Node binary

function isSqlitePath(p) {
  return /\.sqlite$/i.test(p || '');
}

let _Database = null;
function loadBetterSqlite() {
  if (_Database) return _Database;
  // Try the bundled native binary 9router ships with first — guaranteed
  // to be ABI-compatible with the Node we're using since it's the same
  // node binary that 9router runs.
  const candidates = [NINER_BETTER_SQLITE, 'better-sqlite3'];
  let lastErr = null;
  for (const cand of candidates) {
    try {
      _Database = require(cand);
      return _Database;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `Không tải được better-sqlite3 (đã thử: ${candidates.join(', ')}). ` +
      `Lỗi cuối: ${lastErr && lastErr.message}`
  );
}

// ---------------------------------------------------------------------------
// expandInputs
// ---------------------------------------------------------------------------

function expandInputs(inputs) {
  const files = [];
  const seen = new Set();
  function pushFile(p) {
    const norm = path.resolve(p);
    if (seen.has(norm)) return;
    seen.add(norm);
    files.push(norm);
  }
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
      } else if (ent.isFile()) {
        const lower = ent.name.toLowerCase();
        if (lower.endsWith('.json') || lower.endsWith('.zip')) {
          pushFile(p);
        }
      }
    }
  }
  for (const inp of inputs || []) {
    if (!inp) continue;
    if (!fs.existsSync(inp)) continue;
    const stat = fs.statSync(inp);
    if (stat.isDirectory()) {
      walk(inp);
    } else if (stat.isFile()) {
      pushFile(inp);
    }
  }
  return files;
}

// Read a single file path on disk and return one or more
// { name, text } "uploads" — JSON files yield 1 upload, ZIP files yield N
// uploads (one per .json entry inside, recursively walked virtually).
let _zipReader = null;
function loadZipReader() {
  if (_zipReader) return _zipReader;
  _zipReader = require('./zip-reader');
  return _zipReader;
}

function readPathAsUploads(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.zip')) {
    const buf = fs.readFileSync(filePath);
    const entries = loadZipReader().readZipEntries(buf, { filter: /\.json$/i });
    const base = path.basename(filePath);
    return entries.map((e) => ({
      name: `${base}!${e.name}`,
      text: e.text,
    }));
  }
  return [
    {
      name: path.basename(filePath),
      text: fs.readFileSync(filePath, 'utf8'),
    },
  ];
}

// Expand an in-memory upload list — each item is { name, text? , zip? } where
// `zip` is base64. JSON entries pass through; ZIP entries are inflated. Used
// by both the CLI (server-side ZIPs) and the GUI (browser-uploaded ZIPs).
function expandUploads(uploads) {
  const out = [];
  const errors = [];
  for (const u of uploads || []) {
    if (!u || typeof u.name !== 'string') continue;
    if (u.zip && typeof u.zip === 'string') {
      let buf;
      try {
        buf = Buffer.from(u.zip, 'base64');
      } catch (e) {
        errors.push({ name: u.name, error: 'ZIP base64 không hợp lệ' });
        continue;
      }
      let entries;
      try {
        entries = loadZipReader().readZipEntries(buf, { filter: /\.json$/i });
      } catch (e) {
        errors.push({ name: u.name, error: `Đọc ZIP lỗi: ${e.message}` });
        continue;
      }
      if (entries.length === 0) {
        errors.push({ name: u.name, error: 'ZIP không có entry .json' });
        continue;
      }
      for (const e of entries) {
        out.push({ name: `${u.name}!${e.name}`, text: e.text });
      }
    } else if (typeof u.text === 'string') {
      out.push({ name: u.name, text: u.text });
    }
  }
  return { uploads: out, errors };
}

// Tiny concurrency-limited mapper. Used to throttle online plan verification
// so a single bulk upload doesn't fan out 50 simultaneous HTTPS requests.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length)))
    .fill(0)
    .map(async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// JWT decoding (no signature verification — we only want claims)
// ---------------------------------------------------------------------------

function base64UrlDecode(s) {
  if (typeof s !== 'string' || s.length === 0) return null;
  let str = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = str.length % 4;
  if (pad === 2) str += '==';
  else if (pad === 3) str += '=';
  else if (pad !== 0) return null;
  try {
    return Buffer.from(str, 'base64').toString('utf8');
  } catch (_) {
    return null;
  }
}

function decodeJwtPayload(jwt) {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  const decoded = base64UrlDecode(parts[1]);
  if (!decoded) return null;
  try {
    return JSON.parse(decoded);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// parseCodexFile
//
// Accepts a Codex/ChatGPT OAuth JSON file (single object) and returns either
// { entry } ready to be merged into db.json, or { error }.
// ---------------------------------------------------------------------------

// Trim BOM and whitespace from arbitrary input. Tokens copy-pasted by users
// often pick up Unicode/CRLF junk; strip it before treating them as JWTs.
function stripBom(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
function cleanToken(t) {
  if (typeof t !== 'string') return t;
  return stripBom(t).trim();
}

function flattenCodexShape(data) {
  // Shape detection. Returns either { flat } (a flat creds object the rest
  // of the parser can read directly) or { error }. No recursion.
  if (Array.isArray(data)) {
    if (data.length === 0) return { error: 'Mảng rỗng' };
    // Take the first non-null object — common with bare arrays of creds.
    const first = data.find((x) => x && typeof x === 'object');
    if (!first) return { error: 'Mảng không có object hợp lệ' };
    return flattenCodexShape(first);
  }
  if (data.accounts && Array.isArray(data.accounts)) {
    const acc = data.accounts.find(
      (a) =>
        a &&
        typeof a === 'object' &&
        (a.platform === 'openai' ||
          a.platform === 'codex' ||
          a.type === 'codex' ||
          (a.credentials && (a.credentials.access_token || a.credentials.accessToken)))
    );
    if (!acc) return { error: 'Không tìm thấy account openai/codex trong "accounts[]"' };
    const merged = {
      ...(acc.credentials || {}),
      ...(acc.extra || {}),
      email:
        (acc.extra && acc.extra.email) ||
        acc.name ||
        (acc.credentials && acc.credentials.email),
      account_id:
        (acc.credentials && acc.credentials.chatgpt_account_id) ||
        (acc.credentials && acc.credentials.account_id),
    };
    return { flat: merged };
  }
  if (data.tokens && typeof data.tokens === 'object' && !Array.isArray(data.tokens)) {
    return {
      flat: {
        ...data.tokens,
        email: data.tokens.email || data.email,
        last_refresh: data.last_refresh || data.tokens.last_refresh,
      },
    };
  }
  return { flat: data };
}

function parseCodexFile(jsonText) {
  // Tolerate UTF-8 BOM on disk and surrounding whitespace.
  const cleanText = stripBom(typeof jsonText === 'string' ? jsonText : '').trim();
  let data;
  try {
    data = JSON.parse(cleanText);
  } catch (e) {
    return { error: `JSON không hợp lệ: ${e.message}` };
  }
  if (!data || typeof data !== 'object') {
    return { error: 'File phải là JSON object/array' };
  }

  const flat = flattenCodexShape(data);
  if (flat.error) return { error: flat.error };
  data = flat.flat;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: 'File phải là JSON object sau khi mở rộng' };
  }

  const accessToken = cleanToken(data.access_token || data.accessToken);
  const refreshToken = cleanToken(data.refresh_token || data.refreshToken);
  if (typeof accessToken !== 'string' || !accessToken) {
    return { error: 'Thiếu access_token' };
  }
  if (typeof refreshToken !== 'string' || !refreshToken) {
    return { error: 'Thiếu refresh_token' };
  }

  // Decode JWT claims if available — fall back to top-level fields.
  const idToken = cleanToken(data.id_token || data.idToken);
  const idTokenClaims = decodeJwtPayload(idToken) || {};
  const accessClaims = decodeJwtPayload(accessToken) || {};

  const profile =
    idTokenClaims['https://api.openai.com/profile'] ||
    accessClaims['https://api.openai.com/profile'] ||
    {};
  const auth =
    idTokenClaims['https://api.openai.com/auth'] ||
    accessClaims['https://api.openai.com/auth'] ||
    {};

  const email =
    (typeof profile.email === 'string' && profile.email.trim()) ||
    (typeof data.email === 'string' && data.email.trim()) ||
    null;

  const chatgptAccountId =
    (typeof auth.chatgpt_account_id === 'string' && auth.chatgpt_account_id) ||
    (typeof data.chatgpt_account_id === 'string' && data.chatgpt_account_id) ||
    (typeof data.account_id === 'string' && data.account_id) ||
    null;

  const chatgptPlanType =
    (typeof auth.chatgpt_plan_type === 'string' && auth.chatgpt_plan_type) ||
    'free';

  // expiresAt: prefer explicit "expired" or "expires_at" field. Both ISO
  // strings and Unix epochs (seconds or milliseconds) are accepted.
  let expiresAt = null;
  function epochToIso(n) {
    if (!Number.isFinite(n) || n <= 0) return null;
    // Heuristic: anything < 1e12 is seconds, ≥ 1e12 is ms.
    const ms = n < 1e12 ? n * 1000 : n;
    return new Date(ms).toISOString();
  }
  const expiredField = data.expired || data.expires_at || data.expiresAt;
  if (typeof expiredField === 'string' && expiredField) {
    const t = Date.parse(expiredField);
    if (!Number.isNaN(t)) expiresAt = new Date(t).toISOString();
  } else if (typeof expiredField === 'number') {
    expiresAt = epochToIso(expiredField);
  }
  if (!expiresAt && typeof data.expires_in === 'number' && data.expires_in > 0) {
    expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  }
  if (!expiresAt && typeof data.last_refresh === 'string') {
    const t = Date.parse(data.last_refresh);
    if (!Number.isNaN(t)) {
      expiresAt = new Date(t + 10 * 24 * 3600 * 1000).toISOString();
    }
  }
  if (!expiresAt) {
    expiresAt = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
  }

  const now = new Date().toISOString();
  // Canonical display name: email if we have it, otherwise a stable label
  // derived from the account id. mergeEntries dedupes by `name` (lowercase
  // email) and accessToken — keep this consistent.
  const name = email
    ? email
    : chatgptAccountId
    ? `Codex ${chatgptAccountId.slice(0, 8)}`
    : `Codex ${randomUUID().slice(0, 8)}`;

  const entry = {
    id: randomUUID(),
    provider: 'codex',
    authType: 'oauth',
    name,
    email: email || null,
    priority: 0, // will be reassigned by mergeEntries
    isActive: true,
    createdAt: now,
    updatedAt: now,
    accessToken,
    refreshToken,
    expiresAt,
    testStatus: 'active',
    providerSpecificData: {
      chatgptAccountId: chatgptAccountId || '',
      chatgptPlanType: chatgptPlanType || 'free',
      authMethod: 'imported',
      provider: 'Imported',
    },
  };

  return {
    entry,
    source: {
      email,
      chatgptAccountId,
      chatgptPlanType,
      chatgptPlanFromJwt: chatgptPlanType,
      expiresAt,
      refreshTail: refreshToken.slice(-8),
      accessToken, // kept transient for online verification; do NOT log
    },
  };
}

// ---------------------------------------------------------------------------
// ChatGPT subscriptions API — verify real plan online
//
// Calls https://chatgpt.com/backend-api/subscriptions?account_id=<id>
// with Authorization: Bearer <access_token>. Returns the plan name observed,
// or null on any error/timeout.
// Response shape (relevant subset):
//   { plan_type: "plus" | "free" | ..., subscription_id, ... }
// or sometimes { has_subscription: bool, plan: { ... } }.
// ---------------------------------------------------------------------------

function verifyChatgptPlan({ accessToken, accountId, timeoutMs = 6000, retries = 1 }) {
  return new Promise((resolve) => {
    if (!accessToken || !accountId) {
      resolve({ ok: false, reason: 'missing_input' });
      return;
    }
    let attempt = 0;
    function doRequest() {
      const u = new URL(
        `https://chatgpt.com/backend-api/subscriptions?account_id=${encodeURIComponent(accountId)}`
      );
      const req = https.request(
        {
          method: 'GET',
          hostname: u.hostname,
          port: 443,
          path: u.pathname + u.search,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            'User-Agent':
              'codex-cli/1.0.18 (9router-codex-importer)',
            'OAI-Client-Version': 'codex-cli',
          },
          timeout: timeoutMs,
        },
        (res) => {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (buf += c));
          res.on('end', () => {
            if (res.statusCode !== 200) {
              // HTTP errors (401/403/etc) are deterministic — don't retry.
              resolve({
                ok: false,
                status: res.statusCode,
                reason: `http_${res.statusCode}`,
                body: buf.slice(0, 500),
              });
              return;
            }
            let body;
            try {
              body = JSON.parse(buf);
            } catch (e) {
              resolve({ ok: false, reason: 'parse_error', body: buf.slice(0, 500) });
              return;
            }
            const plan =
              (typeof body.plan_type === 'string' && body.plan_type) ||
              (body.plan && typeof body.plan.name === 'string' && body.plan.name) ||
              (body.plan && typeof body.plan.plan_type === 'string' && body.plan.plan_type) ||
              (typeof body.subscription_plan === 'string' && body.subscription_plan) ||
              null;
            const planTypeRaw = plan ? String(plan).toLowerCase() : null;
            const normalised = normalisePlan(planTypeRaw);
            resolve({
              ok: true,
              plan: normalised,
              rawPlan: plan,
              hasSubscription:
                body.has_subscription === true ||
                !!body.subscription_id ||
                (body.plan && body.plan.is_active === true) ||
                false,
              body,
            });
          });
        }
      );
      req.on('timeout', () => {
        req.destroy();
        retryOrFail({ ok: false, reason: 'timeout' });
      });
      req.on('error', (e) => {
        retryOrFail({ ok: false, reason: e.message });
      });
      req.end();
    }
    function retryOrFail(err) {
      // Single retry on network-level failures only (DNS, ECONNRESET,
      // timeout). HTTP errors above are NOT retried.
      attempt += 1;
      if (attempt <= retries) {
        setTimeout(doRequest, 250);
      } else {
        resolve(err);
      }
    }
    doRequest();
  });
}

// Map any plan label (chatgpt-plus / Plus / cx/plus / team-monthly / …) to
// our canonical short form. Returns the input lowercased if nothing matches,
// or null when input is empty.
function normalisePlan(planTypeRaw) {
  if (!planTypeRaw) return null;
  const s = String(planTypeRaw).toLowerCase();
  // Strip a leading "cx/" or "openai/" prefix.
  const stripped = s.replace(/^(?:cx|openai|chatgpt)[\/-]/, '');
  if (/plus/.test(stripped)) return 'plus';
  if (/team/.test(stripped)) return 'team';
  if (/pro/.test(stripped)) return 'pro';
  if (/enterprise|edu/.test(stripped)) return 'enterprise';
  if (/free/.test(stripped)) return 'free';
  return stripped || s;
}

// ---------------------------------------------------------------------------
// Codex CLI auto-config
//
// Goal: make sure that after we import a Codex/ChatGPT account, running
// `codex` immediately works against 9router (no 401 Invalid API key, no
// "auth_mode: chatgpt" leftover from an older device login).
//
// Two files are touched, mirroring what 9router's own /api/cli-tools/codex-
// settings POST endpoint would do:
//
//   ~/.codex/config.toml
//     model_provider = "9router"
//     [model_providers.9router]
//     name      = "9Router"
//     base_url  = "<baseUrl>/v1"
//     wire_api  = "responses"
//
//   ~/.codex/auth.json
//     { "OPENAI_API_KEY": "<key>", "auth_mode": "apikey", ... preserved ... }
//
// The api key is read from db.json (first active entry in apiKeys[]). If
// requireApiKey is enabled and there is no active key, we create one named
// "Codex Auto" and persist it back to db.json.
// ---------------------------------------------------------------------------

function codexHomeDir() {
  return path.join(os.homedir(), '.codex');
}

function codexConfigPath() {
  return path.join(codexHomeDir(), 'config.toml');
}

function codexAuthPath() {
  return path.join(codexHomeDir(), 'auth.json');
}

function pickOrCreateApiKey(db, { log = () => {} } = {}) {
  if (!db || typeof db !== 'object') return null;
  if (!Array.isArray(db.apiKeys)) db.apiKeys = [];
  // Prefer an existing active key.
  const existing = db.apiKeys.find((k) => k && k.isActive && k.key);
  if (existing) return { key: existing.key, created: false, name: existing.name };

  // None active — create one. Match 9router's general key shape: sk-<hex>.
  const machineId = randomUUID().replace(/-/g, '').slice(0, 16);
  const tail =
    randomUUID().replace(/-/g, '').slice(0, 6) +
    '-' +
    randomUUID().replace(/-/g, '').slice(0, 8);
  const newKey = `sk-${machineId}-${tail}`;
  const row = {
    id: randomUUID(),
    name: 'Codex Auto',
    key: newKey,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
  };
  db.apiKeys.push(row);
  log('Đã tạo API key mới trong 9router: "Codex Auto"');
  return { key: newKey, created: true, name: row.name };
}

// Tiny, surgical TOML writer. We do NOT parse the full file — we only edit
// the few keys we care about, preserving the rest verbatim. This handles
// the realistic case where 9router (or the Codex desktop app) has already
// written its own keys into config.toml.
function ensureConfigToml({ baseUrl, log = () => {} }) {
  const file = codexConfigPath();
  const v1 = baseUrl.replace(/\/+$/, '').endsWith('/v1')
    ? baseUrl.replace(/\/+$/, '')
    : `${baseUrl.replace(/\/+$/, '')}/v1`;

  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    text = '';
  }

  // 1) Ensure top-level `model_provider = "9router"`.
  const mpLineRe = /^model_provider\s*=.*$/m;
  if (mpLineRe.test(text)) {
    text = text.replace(mpLineRe, 'model_provider = "9router"');
  } else {
    // Insert at top, before any [section] header.
    const firstSection = text.search(/^\[/m);
    const insertion = 'model_provider = "9router"\n';
    if (firstSection === -1) {
      text = (text ? text.replace(/\s*$/, '\n') : '') + insertion;
    } else {
      text =
        text.slice(0, firstSection) +
        insertion +
        text.slice(firstSection);
    }
  }

  // 1b) Ensure top-level `model` is prefixed with "cx/" so 9router routes to
  // the codex provider instead of trying (and failing) to find an `openai`
  // credential. The 9router dashboard's "Apply 9Router Settings" button
  // ships an unprefixed model name, which produces:
  //   404 Not Found: No active credentials for provider: openai
  // We fix that here at the source so users don't need to know.
  const modelLineRe = /^model\s*=\s*"([^"]*)"\s*$/m;
  const m = modelLineRe.exec(text);
  if (m) {
    const cur = m[1];
    if (cur && !cur.includes('/')) {
      // Bare name like "gpt-5.5" → "cx/gpt-5.5". Leave alone if it already
      // has any prefix (cx/, openai/, etc.) — user's choice.
      const fixed = `cx/${cur}`;
      text = text.replace(modelLineRe, `model = "${fixed}"`);
      log(`Codex CLI model: "${cur}" → "${fixed}" (thêm prefix cx/)`);
    }
  } else {
    // No model line at all — pick a sensible default.
    const insertion = 'model = "cx/gpt-5.5"\n';
    const firstSection = text.search(/^\[/m);
    if (firstSection === -1) text += insertion;
    else text = text.slice(0, firstSection) + insertion + text.slice(firstSection);
  }

  // 2) Ensure [model_providers.9router] block. We can't use \Z (not valid
  // in JS regex). Match either "up to the next [section] header" OR "to
  // end of string" by anchoring with a sticky scan: locate the header,
  // then find the next `^[` (or end) by hand.
  const headerRe = /^\[model_providers\.9router\][^\n]*\n/m;
  const headerMatch = headerRe.exec(text);
  const desiredBlock =
    '[model_providers.9router]\n' +
    'name = "9Router"\n' +
    `base_url = "${v1}"\n` +
    'wire_api = "responses"\n\n';
  if (headerMatch) {
    const blockStart = headerMatch.index;
    // Find the next [section] header AFTER our header line. Scan from
    // the byte right after the matched header line.
    const afterHeader = headerMatch.index + headerMatch[0].length;
    const nextSectionRe = /^\[/m;
    nextSectionRe.lastIndex = afterHeader;
    const tail = text.slice(afterHeader);
    const nextRel = tail.search(/^\[/m);
    const blockEnd = nextRel === -1 ? text.length : afterHeader + nextRel;
    text = text.slice(0, blockStart) + desiredBlock + text.slice(blockEnd);
  } else {
    if (!text.endsWith('\n')) text += '\n';
    text += '\n' + desiredBlock;
  }

  // Ensure trailing newline, no triple-blank tail.
  text = text.replace(/\n{3,}$/g, '\n\n').replace(/\s*$/, '\n');

  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  log(`Đã cập nhật ${file}`);
  return file;
}

function ensureAuthJson({ apiKey, log = () => {} }) {
  const file = codexAuthPath();
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) cur = {};
  } catch (_) {
    cur = {};
  }
  // Backup once, only if file existed and was non-empty.
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(file, `${file}.bak-${ts}`);
    }
  } catch (_) {
    /* best effort */
  }
  cur.OPENAI_API_KEY = apiKey;
  cur.auth_mode = 'apikey';
  // Preserve cur.tokens / cur.last_refresh if present — Codex CLI ignores
  // them once auth_mode = apikey, but keeping them doesn't hurt.

  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cur, null, 2), 'utf8');
  log(`Đã cập nhật ${file} (auth_mode=apikey, OPENAI_API_KEY=sk-…${apiKey.slice(-6)})`);
  return file;
}

/**
 * Apply 9router config to Codex CLI in one shot.
 *  - mutates `db` in place to ensure an active apiKey exists
 *  - writes ~/.codex/config.toml (idempotent)
 *  - writes ~/.codex/auth.json (apikey mode)
 *
 * Returns { configPath, authPath, apiKey, createdKey }.
 *
 * Caller is responsible for persisting `db` (saveDb) afterwards if the key
 * was newly created.
 */
function configureCodexCli({ db, baseUrl = DEFAULT_BASE_URL, log = () => {} }) {
  const picked = pickOrCreateApiKey(db, { log });
  if (!picked) throw new Error('Không tìm/tạo được API key trong 9router');

  const configPath = ensureConfigToml({ baseUrl, log });
  const authPath = ensureAuthJson({ apiKey: picked.key, log });

  return {
    configPath,
    authPath,
    apiKey: picked.key,
    apiKeyName: picked.name,
    createdKey: picked.created,
  };
}

// ---------------------------------------------------------------------------
// 9router process detection / control (Windows-focused)
// ---------------------------------------------------------------------------

function probeHttp(baseUrl, urlPath, timeoutMs) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(baseUrl);
    } catch (_) {
      resolve(false);
      return;
    }
    const req = http.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || 80,
        path: urlPath,
        timeout: timeoutMs,
      },
      (res) => {
        // Any HTTP response means something is listening.
        res.resume();
        resolve(true);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function is9routerRunning(baseUrl = DEFAULT_BASE_URL) {
  // Try the dashboard first; on a busy box it can be slow, so fall back to
  // health endpoints that are cheap to serve.
  if (await probeHttp(baseUrl, '/', 1500)) return true;
  if (await probeHttp(baseUrl, '/healthz', 800)) return true;
  if (await probeHttp(baseUrl, '/api/health', 800)) return true;
  return false;
}

function getPidsOnPort(port) {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess) -join ','`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 }
    );
    const pids = (out || '')
      .trim()
      .split(/[, \r\n]+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    return Array.from(new Set(pids));
  } catch (_) {
    return [];
  }
}

function get9routerCliPids() {
  // Find any node.exe whose CommandLine contains 9router\cli.js (the tray).
  if (process.platform !== 'win32') return [];
  try {
    const cmd =
      "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | " +
      "Where-Object { $_.CommandLine -match '9router' } | " +
      'Select-Object -ExpandProperty ProcessId';
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', cmd],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 }
    );
    const pids = (out || '')
      .trim()
      .split(/\s+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    return Array.from(new Set(pids));
  } catch (_) {
    return [];
  }
}

function killPid(pid) {
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 8000,
    });
    return true;
  } catch (_) {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function stop9router({ log = () => {}, baseUrl = DEFAULT_BASE_URL } = {}) {
  const targets = new Set([
    ...getPidsOnPort(20128),
    ...get9routerCliPids(),
  ]);
  const killedPids = [];
  for (const pid of targets) {
    if (killPid(pid)) killedPids.push(pid);
  }
  // Wait until port 20128 is free (max 10s).
  for (let i = 0; i < 20; i++) {
    const stillUp = await is9routerRunning(baseUrl);
    if (!stillUp && getPidsOnPort(20128).length === 0) {
      log(`9router đã dừng (đã kill ${killedPids.length} process).`);
      return { stopped: true, killedPids };
    }
    await sleep(500);
  }
  log(`Cảnh báo: 9router vẫn còn trên cổng 20128 sau 10s.`);
  return { stopped: false, killedPids };
}

function start9router({ log = () => {}, cliPath = NINER_CLI } = {}) {
  if (!fs.existsSync(cliPath)) {
    log(`Không tìm thấy 9router CLI tại: ${cliPath}`);
    return { started: false };
  }
  // Spawn detached, exactly mirroring the tray invocation.
  const child = spawn(
    NODE_EXE,
    [cliPath, '--tray', '--skip-update'],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    }
  );
  child.unref();
  log(`Đã spawn 9router tray (pid ${child.pid}).`);
  return { started: true, pid: child.pid };
}

async function waitFor9routerUp(baseUrl = DEFAULT_BASE_URL, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await is9routerRunning(baseUrl)) return true;
    await sleep(500);
  }
  return false;
}

// ---------------------------------------------------------------------------
// db.json IO
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// db IO — supports both legacy db.json and new SQLite (data.sqlite).
//
// Internally we always present the same shape to callers:
//   { providerConnections: [...flat objects...], apiKeys: [...] }
//
// SQLite stores most provider fields in a JSON blob in `data` column. Reading
// expands that back into a single object. Saving collapses it again.
// ---------------------------------------------------------------------------

// Fields that live as TOP-LEVEL columns in providerConnections (vs inside data)
const PC_TOP_LEVEL = ['id', 'provider', 'authType', 'name', 'email', 'priority', 'isActive'];

function expandPcRow(row) {
  let data = {};
  if (typeof row.data === 'string' && row.data.trim()) {
    try {
      data = JSON.parse(row.data);
    } catch (_) {
      data = {};
    }
  }
  const out = {
    ...data,
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: typeof row.priority === 'number' ? row.priority : 0,
    isActive: !!row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return out;
}

function collapsePcEntry(entry) {
  // Pull top-level columns out of the entry, the rest goes into data.
  const data = { ...entry };
  for (const k of PC_TOP_LEVEL) delete data[k];
  delete data.createdAt;
  delete data.updatedAt;
  return {
    id: entry.id,
    provider: entry.provider,
    authType: entry.authType,
    name: entry.name || null,
    email: entry.email || null,
    priority: entry.priority || 0,
    isActive: entry.isActive ? 1 : 0,
    data: JSON.stringify(data),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function loadDb(dbPath) {
  if (isSqlitePath(dbPath)) {
    if (!fs.existsSync(dbPath)) {
      // Will be created on save.
      return {
        providerConnections: [],
        apiKeys: [],
        __backend: 'sqlite',
        __dbPath: dbPath,
      };
    }
    const Database = loadBetterSqlite();
    const conn = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const pcRows = conn.prepare('SELECT * FROM providerConnections').all();
      const akRows = conn.prepare('SELECT * FROM apiKeys').all();
      return {
        providerConnections: pcRows.map(expandPcRow),
        apiKeys: akRows.map((r) => ({
          id: r.id,
          key: r.key,
          name: r.name,
          machineId: r.machineId,
          isActive: !!r.isActive,
          createdAt: r.createdAt,
        })),
        __backend: 'sqlite',
        __dbPath: dbPath,
      };
    } finally {
      conn.close();
    }
  }

  // Legacy JSON fallback.
  if (!fs.existsSync(dbPath)) {
    return {
      providerConnections: [],
      providerNodes: [],
      proxyPools: [],
      modelAliases: {},
      mitmAlias: {},
      combos: [],
      apiKeys: [],
      settings: {},
      pricing: {},
      __backend: 'json',
      __dbPath: dbPath,
    };
  }
  const raw = fs.readFileSync(dbPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Không đọc được db.json: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('db.json không phải object');
  }
  if (!Array.isArray(parsed.providerConnections)) parsed.providerConnections = [];
  if (!Array.isArray(parsed.apiKeys)) parsed.apiKeys = [];
  parsed.__backend = 'json';
  parsed.__dbPath = dbPath;
  return parsed;
}

function backupDb(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${dbPath}.bak-${ts}`;
  // For SQLite, copy the .sqlite file. We do NOT copy -wal/-shm because the
  // server is stopped before we touch the DB.
  fs.copyFileSync(dbPath, bak);
  return bak;
}

function saveDb(dbPath, db) {
  if (isSqlitePath(dbPath) || db.__backend === 'sqlite') {
    const Database = loadBetterSqlite();
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Open writable. If file doesn't exist, create with a minimal schema
    // matching what 9router itself uses (TEXT id PK + JSON data column).
    //
    // NOTE: This codepath only ever upserts — it never deletes rows that
    // were removed from the in-memory copy. For our use case (we only ever
    // *add* providerConnections, and append/refresh apiKeys) that's fine.
    // If the importer ever needs to delete, this would need a different
    // strategy (DELETE WHERE id NOT IN (…)).
    const conn = new Database(dbPath);
    try {
      conn.pragma('journal_mode = WAL');
      conn.exec(`
        CREATE TABLE IF NOT EXISTS providerConnections (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          authType TEXT NOT NULL,
          name TEXT,
          email TEXT,
          priority INTEGER,
          isActive INTEGER DEFAULT 1,
          data TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS apiKeys (
          id TEXT PRIMARY KEY,
          key TEXT UNIQUE NOT NULL,
          name TEXT,
          machineId TEXT,
          isActive INTEGER DEFAULT 1,
          createdAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider);
        CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive);
        CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority);
        CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key);
      `);

      const upsertPc = conn.prepare(
        `INSERT INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
         VALUES (@id, @provider, @authType, @name, @email, @priority, @isActive, @data, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           provider=excluded.provider,
           authType=excluded.authType,
           name=excluded.name,
           email=excluded.email,
           priority=excluded.priority,
           isActive=excluded.isActive,
           data=excluded.data,
           updatedAt=excluded.updatedAt`
      );
      const upsertAk = conn.prepare(
        `INSERT INTO apiKeys (id, key, name, machineId, isActive, createdAt)
         VALUES (@id, @key, @name, @machineId, @isActive, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           key=excluded.key,
           name=excluded.name,
           machineId=excluded.machineId,
           isActive=excluded.isActive`
      );
      const tx = conn.transaction(() => {
        for (const e of db.providerConnections || []) {
          upsertPc.run(collapsePcEntry(e));
        }
        for (const k of db.apiKeys || []) {
          upsertAk.run({
            id: k.id,
            key: k.key,
            name: k.name || '',
            machineId: k.machineId || '',
            isActive: k.isActive ? 1 : 0,
            createdAt: k.createdAt || new Date().toISOString(),
          });
        }
      });
      tx();
    } finally {
      conn.close();
    }
    return;
  }

  // Legacy JSON: atomic write via tmp + rename. Strip our internal markers.
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const out = { ...db };
  delete out.__backend;
  delete out.__dbPath;
  const tmp = `${dbPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  fs.renameSync(tmp, dbPath);
}

// ---------------------------------------------------------------------------
// mergeEntries
//
// Skips entries whose email matches an existing codex entry (case-insensitive)
// OR whose accessToken matches an existing codex entry. Reassigns priority so
// new entries are appended at the end of the codex priority range.
//
// Counts in the return value are explicit and non-overlapping:
//   - added:        brand-new entries
//   - refreshed:    duplicates that were updated in place (token rotation)
//   - skippedOnly:  duplicates that were left untouched (refreshOnDuplicate=false)
// `skipped` is kept for backwards compat and equals `refreshed + skippedOnly`.
// ---------------------------------------------------------------------------

function mergeEntries(db, entries, opts = {}) {
  const skipDuplicates = opts.skipDuplicates !== false;
  const refreshOnDuplicate = opts.refreshOnDuplicate !== false;
  if (!Array.isArray(db.providerConnections)) db.providerConnections = [];
  const codexExisting = db.providerConnections.filter(
    (e) => e && e.provider === 'codex'
  );
  // Map email/token → reference to the existing entry (so we can mutate).
  const byEmail = new Map();
  const byToken = new Map();
  for (const e of codexExisting) {
    const key = (e.name || '').toLowerCase().trim();
    if (key) byEmail.set(key, e);
    if (e.accessToken) byToken.set(e.accessToken, e);
  }

  let maxPriority = 0;
  for (const e of db.providerConnections) {
    if (e && e.provider === 'codex' && Number.isFinite(e.priority)) {
      if (e.priority > maxPriority) maxPriority = e.priority;
    }
  }

  const added = [];
  const refreshed = [];
  const skippedOnly = [];
  for (const entry of entries) {
    const emailKey = (entry.name || '').toLowerCase().trim();
    const dupByEmail = emailKey ? byEmail.get(emailKey) : null;
    const dupByToken = byToken.get(entry.accessToken);
    const existing = dupByEmail || dupByToken;

    if (skipDuplicates && existing) {
      if (refreshOnDuplicate) {
        // Update mutable fields of the existing entry, but preserve id and
        // createdAt. This is what makes plan corrections (free → plus) flow
        // through to db.json on a re-import.
        existing.accessToken = entry.accessToken;
        existing.refreshToken = entry.refreshToken;
        existing.expiresAt = entry.expiresAt;
        existing.testStatus = entry.testStatus || existing.testStatus;
        existing.updatedAt = new Date().toISOString();
        if (entry.providerSpecificData && existing.providerSpecificData) {
          existing.providerSpecificData = {
            ...existing.providerSpecificData,
            ...entry.providerSpecificData,
          };
        } else if (entry.providerSpecificData) {
          existing.providerSpecificData = entry.providerSpecificData;
        }
        // Refresh token map so subsequent dupes within the same batch are
        // matched against the new accessToken.
        if (entry.accessToken) byToken.set(entry.accessToken, existing);
        refreshed.push(existing);
      } else {
        skippedOnly.push(entry);
      }
      continue;
    }

    maxPriority += 1;
    const e = { ...entry, priority: maxPriority };
    db.providerConnections.push(e);
    if (emailKey) byEmail.set(emailKey, e);
    if (e.accessToken) byToken.set(e.accessToken, e);
    added.push(e);
  }

  return {
    added: added.length,
    refreshed: refreshed.length,
    skippedOnly: skippedOnly.length,
    // Backwards-compat: total entries that were not added (refreshed + skipped).
    skipped: refreshed.length + skippedOnly.length,
    addedEmails: added.map((e) => e.name),
    refreshedEmails: refreshed.map((e) => e.name),
    skippedEmails: skippedOnly.map((e) => e.name),
  };
}

// ---------------------------------------------------------------------------
// parseUploads
//
// Pure parse pipeline used by both the CLI (--list) and the GUI (/api/parse).
// Takes a list of uploads ({name, text} or {name, zip:base64}), expands ZIPs,
// runs parseCodexFile, and optionally runs verifyChatgptPlan with a small
// concurrency limit. Returns row objects suitable for display.
//
// Tokens are NEVER returned — `accessToken` is stripped from every row.
// ---------------------------------------------------------------------------

async function parseUploads(uploads, opts = {}) {
  const verifyPlanOnline = opts.verifyPlanOnline !== false;
  const verifyTimeoutMs = opts.verifyTimeoutMs || 6000;
  const verifyConcurrency =
    Number.isFinite(opts.verifyConcurrency) && opts.verifyConcurrency > 0
      ? Math.min(64, Math.floor(opts.verifyConcurrency))
      : 6;

  const { uploads: expanded, errors } = expandUploads(uploads);
  const rows = [];
  for (const e of errors) rows.push({ name: e.name, error: e.error });
  const verifyTargets = [];
  for (const u of expanded) {
    if (!u || typeof u.text !== 'string') continue;
    const r = parseCodexFile(u.text);
    if (r.error) {
      rows.push({ name: u.name, error: r.error });
    } else {
      const row = { name: u.name, source: r.source };
      rows.push(row);
      if (verifyPlanOnline && r.source.accessToken && r.source.chatgptAccountId) {
        verifyTargets.push(row);
      } else if (r.source) {
        // No verification possible — annotate so the UI can show "JWT only".
        row.source.planSource = 'jwt_only';
      }
    }
  }

  if (verifyTargets.length > 0) {
    await mapWithConcurrency(verifyTargets, verifyConcurrency, async (row) => {
      try {
        const v = await verifyChatgptPlan({
          accessToken: row.source.accessToken,
          accountId: row.source.chatgptAccountId,
          timeoutMs: verifyTimeoutMs,
        });
        if (v.ok && v.plan) {
          row.source.chatgptPlanFromJwt = row.source.chatgptPlanType;
          row.source.chatgptPlanType = v.plan;
          row.source.planSource = 'subscriptions_api';
        } else {
          row.source.planSource = 'jwt_only';
          row.source.planVerificationError = v.reason || 'unknown';
        }
      } catch (e) {
        row.source.planSource = 'jwt_only';
        row.source.planVerificationError = e.message;
      }
    });
  }

  // Strip transient accessToken from every row before returning.
  for (const row of rows) {
    if (row.source) delete row.source.accessToken;
  }
  return rows;
}

// ---------------------------------------------------------------------------
//
// Steps:
//   1. Detect 9router. If running:
//      - dryRun                 -> proceed (read-only).
//      - forceStop              -> stop, do work, restart.
//      - noRestart              -> caller wants to write while server is up;
//                                 we refuse (error code 4) since in-memory db
//                                 will overwrite our changes.
//      - default                -> same as forceStop (stop+restart).
//   2. Backup db.json.
//   3. Read, parse all input files, merge new entries, atomic write.
//   4. Restart 9router if it was running and noRestart is false.
//   5. Return a structured report.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// bulkImport — orchestrator
//
// Steps:
//   1. Detect 9router. If running:
//      - dryRun                 -> proceed (read-only).
//      - forceStop              -> stop, do work, restart.
//      - noRestart              -> caller wants to write while server is up;
//                                 we refuse (error code 4) since in-memory db
//                                 will overwrite our changes.
//      - default                -> same as forceStop (stop+restart).
//   2. Backup db.json.
//   3. Read, parse all input files, merge new entries, atomic write.
//   4. Restart 9router if it was running and noRestart is false.
//   5. Return a structured report.
// ---------------------------------------------------------------------------

async function bulkImport(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  const inputs = Array.isArray(opts.inputs) ? opts.inputs : [];
  const dryRun = !!opts.dryRun;
  const forceStop = !!opts.forceStop;
  const noRestart = !!opts.noRestart;
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
  const skipDuplicates = opts.skipDuplicates !== false;

  // 0) expand & parse inputs first (fail fast on no files).
  const verifyPlanOnline = opts.verifyPlanOnline !== false;
  const verifyConcurrency =
    Number.isFinite(opts.verifyConcurrency) && opts.verifyConcurrency > 0
      ? Math.min(64, Math.floor(opts.verifyConcurrency))
      : 6;
  const files = expandInputs(inputs);
  const parsed = [];
  for (const f of files) {
    let uploads;
    try {
      uploads = readPathAsUploads(f);
    } catch (e) {
      parsed.push({ file: f, error: `Không đọc được file: ${e.message}` });
      continue;
    }
    if (uploads.length === 0) {
      parsed.push({ file: f, error: 'Không có entry .json nào trong file ZIP' });
      continue;
    }
    for (const u of uploads) {
      const r = parseCodexFile(u.text);
      const displayName = uploads.length === 1 ? f : `${f}::${u.name}`;
      if (r.error) parsed.push({ file: displayName, error: r.error });
      else parsed.push({ file: displayName, entry: r.entry, source: r.source });
    }
  }

  // 0.5) Best-effort online plan verification for each parsed entry. Updates
  // the entry's providerSpecificData.chatgptPlanType in place if the API
  // returns a different plan than what the JWT claims (e.g. user upgraded
  // to Plus after the token was issued).
  //
  // To avoid hammering chatgpt.com on a 50-account import we cap concurrency
  // at `verifyConcurrency` (default 6).
  if (verifyPlanOnline) {
    const targets = parsed.filter(
      (p) =>
        p.entry &&
        p.source &&
        p.source.accessToken &&
        p.source.chatgptAccountId
    );
    await mapWithConcurrency(targets, verifyConcurrency, async (p) => {
      try {
        const v = await verifyChatgptPlan({
          accessToken: p.source.accessToken,
          accountId: p.source.chatgptAccountId,
          timeoutMs: opts.verifyTimeoutMs || 6000,
        });
        p.source.planVerification = v;
        if (v.ok && v.plan) {
          if (v.plan !== p.source.chatgptPlanType) {
            log(
              `Plan thực tế khác JWT cho ${p.source.email || p.source.chatgptAccountId}: ` +
                `JWT="${p.source.chatgptPlanType}" → API="${v.plan}". Dùng API.`
            );
          }
          p.source.chatgptPlanType = v.plan;
          if (p.entry && p.entry.providerSpecificData) {
            p.entry.providerSpecificData.chatgptPlanType = v.plan;
            p.entry.providerSpecificData.planSource = 'subscriptions_api';
          }
        } else {
          if (p.entry && p.entry.providerSpecificData) {
            p.entry.providerSpecificData.planSource = 'jwt_only';
            p.entry.providerSpecificData.planVerificationError =
              v.reason || 'unknown';
          }
        }
      } catch (e) {
        p.source.planVerification = { ok: false, reason: e.message };
      } finally {
        // Strip transient access token from source so callers/UIs never
        // see it; entry.accessToken remains the canonical store.
        delete p.source.accessToken;
      }
    });
    // Strip access tokens from any non-target sources too (parse errors,
    // missing account id, etc).
    for (const p of parsed) {
      if (p.source) delete p.source.accessToken;
    }
  } else {
    for (const p of parsed) {
      if (p.source) delete p.source.accessToken;
    }
  }

  if (files.length === 0) {
    return {
      ok: false,
      code: 1,
      message: 'Không có file đầu vào hợp lệ',
      parsed,
    };
  }

  // 1) detect 9router
  const wasRunning = await is9routerRunning(baseUrl);
  if (dryRun) {
    return {
      ok: true,
      code: 0,
      dryRun: true,
      wasRunning,
      parsed,
      added: 0,
      skipped: 0,
      backup: null,
      restarted: false,
    };
  }

  if (wasRunning && !forceStop && !noRestart) {
    // default: caller didn't pass --force-stop. To stay safe, refuse.
    return {
      ok: false,
      code: 4,
      message:
        '9router đang chạy. Dùng --force-stop để dừng & khởi động lại tự động.',
      wasRunning,
      parsed,
    };
  }
  if (wasRunning && noRestart && !forceStop) {
    return {
      ok: false,
      code: 4,
      message:
        '9router đang chạy nhưng đã yêu cầu --no-restart. Hãy tắt 9router thủ công hoặc thêm --force-stop.',
      wasRunning,
      parsed,
    };
  }

  // 2) stop if needed
  let stoppedReport = null;
  if (wasRunning) {
    log('9router đang chạy → dừng để cập nhật db.json…');
    stoppedReport = await stop9router({ log, baseUrl });
    if (!stoppedReport.stopped) {
      return {
        ok: false,
        code: 4,
        message: 'Không dừng được 9router — huỷ thao tác để tránh ghi đè.',
        wasRunning,
        parsed,
        stopped: stoppedReport,
      };
    }
  }

  // 3) backup
  let backup = null;
  try {
    backup = backupDb(dbPath);
    if (backup) log(`Backup → ${backup}`);
  } catch (e) {
    log(`Cảnh báo backup: ${e.message}`);
  }

  // 4) load + merge + save
  let added = 0;
  let skipped = 0;
  let skippedOnly = 0;
  let refreshed = 0;
  let addedEmails = [];
  let skippedEmails = [];
  let refreshedEmails = [];
  let writeError = null;
  let codexCliConfig = null;
  try {
    const db = loadDb(dbPath);
    const validEntries = parsed.filter((p) => p.entry).map((p) => p.entry);
    const merge = mergeEntries(db, validEntries, { skipDuplicates });
    added = merge.added;
    skipped = merge.skipped;
    skippedOnly = merge.skippedOnly || 0;
    refreshed = merge.refreshed || 0;
    addedEmails = merge.addedEmails;
    skippedEmails = merge.skippedEmails;
    refreshedEmails = merge.refreshedEmails || [];

    // Auto-configure Codex CLI so the user is never blocked by 401.
    // We do this whenever at least one entry was added (or already exists)
    // so the very first import "just works" end-to-end.
    if (opts.configureCodex !== false) {
      try {
        codexCliConfig = configureCodexCli({ db, baseUrl, log });
        if (codexCliConfig.createdKey) {
          log(
            `API key mới: ${codexCliConfig.apiKeyName} (sk-…${codexCliConfig.apiKey.slice(-6)})`
          );
        }
      } catch (e) {
        log(`Cảnh báo cấu hình Codex CLI: ${e.message}`);
      }
    }

    saveDb(dbPath, db);
    log(
      `Đã ghi DB (${db.__backend || 'json'}) — thêm ${added}, cập nhật ${refreshed} (trùng), bỏ qua ${skippedOnly}.`
    );
  } catch (e) {
    writeError = e.message;
  }

  // 5) restart if it was running and we should
  let restarted = false;
  let restartPid = null;
  if (wasRunning && !noRestart) {
    log('Khởi động lại 9router…');
    const r = start9router({ log });
    if (r.started) {
      restartPid = r.pid;
      const up = await waitFor9routerUp(baseUrl, 30000);
      restarted = up;
      if (!up) log('Cảnh báo: 9router chưa lên cổng 20128 sau 30s.');
      else log('9router đã lên lại.');
    } else {
      log('Khởi động lại 9router thất bại — chạy lại bằng tay nếu cần.');
    }
  }

  if (writeError) {
    return {
      ok: false,
      code: 99,
      message: `Lỗi ghi db.json: ${writeError}`,
      wasRunning,
      parsed,
      backup,
      restarted,
      restartPid,
    };
  }

  const parseFails = parsed.filter((p) => p.error).length;
  return {
    ok: true,
    code: parseFails > 0 ? 3 : 0,
    wasRunning,
    parsed,
    added,
    skipped,
    skippedOnly,
    refreshed,
    addedEmails,
    skippedEmails,
    refreshedEmails,
    backup,
    restarted,
    restartPid,
    codexCliConfig,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_DB_PATH,
  DEFAULT_SQLITE_PATH,
  DEFAULT_JSON_PATH,
  NINER_CLI,
  expandInputs,
  expandUploads,
  readPathAsUploads,
  decodeJwtPayload,
  parseCodexFile,
  parseUploads,
  verifyChatgptPlan,
  normalisePlan,
  is9routerRunning,
  stop9router,
  start9router,
  waitFor9routerUp,
  loadDb,
  saveDb,
  backupDb,
  mergeEntries,
  bulkImport,
  configureCodexCli,
  ensureConfigToml,
  codexConfigPath,
  codexAuthPath,
  // Internal helpers exported for tests:
  _internals: {
    mapWithConcurrency,
    flattenCodexShape,
    stripBom,
    cleanToken,
  },
};
