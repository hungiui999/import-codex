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
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const { randomUUID } = require('crypto');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'http://127.0.0.1:20128';
const DEFAULT_DB_PATH = path.join(
  process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
  '9router',
  'db.json'
);
const NINER_CLI = path.join(
  process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
  'npm',
  'node_modules',
  '9router',
  'cli.js'
);
const NODE_EXE = process.execPath; // current Node binary

// ---------------------------------------------------------------------------
// expandInputs
// ---------------------------------------------------------------------------

function expandInputs(inputs) {
  const files = [];
  for (const inp of inputs || []) {
    if (!inp) continue;
    if (!fs.existsSync(inp)) continue;
    const stat = fs.statSync(inp);
    if (stat.isDirectory()) {
      for (const f of fs.readdirSync(inp)) {
        if (f.toLowerCase().endsWith('.json')) files.push(path.join(inp, f));
      }
    } else if (stat.isFile()) {
      files.push(inp);
    }
  }
  return files;
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

function parseCodexFile(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (e) {
    return { error: `JSON không hợp lệ: ${e.message}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: 'File phải là 1 JSON object (không phải mảng)' };
  }

  const accessToken = data.access_token || data.accessToken;
  const refreshToken = data.refresh_token || data.refreshToken;
  if (typeof accessToken !== 'string' || !accessToken) {
    return { error: 'Thiếu access_token' };
  }
  if (typeof refreshToken !== 'string' || !refreshToken) {
    return { error: 'Thiếu refresh_token' };
  }

  // Decode JWT claims if available — fall back to top-level fields.
  const idTokenClaims = decodeJwtPayload(data.id_token || data.idToken) || {};
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
    (typeof profile.email === 'string' && profile.email) ||
    (typeof data.email === 'string' && data.email) ||
    null;

  const chatgptAccountId =
    (typeof auth.chatgpt_account_id === 'string' && auth.chatgpt_account_id) ||
    (typeof data.account_id === 'string' && data.account_id) ||
    null;

  const chatgptPlanType =
    (typeof auth.chatgpt_plan_type === 'string' && auth.chatgpt_plan_type) ||
    'free';

  // expiresAt: prefer explicit "expired" field (already ISO).
  // Fallback: last_refresh + 10 days, fallback again: now + 10 days.
  let expiresAt = null;
  if (typeof data.expired === 'string' && data.expired) {
    const t = Date.parse(data.expired);
    if (!Number.isNaN(t)) expiresAt = new Date(t).toISOString();
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
      expiresAt,
      refreshTail: refreshToken.slice(-8),
    },
  };
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

  // 2) Ensure [model_providers.9router] block.
  const blockRe =
    /^\[model_providers\.9router\][\s\S]*?(?=^\[|\Z)/m;
  const desiredBlock =
    '[model_providers.9router]\n' +
    'name = "9Router"\n' +
    `base_url = "${v1}"\n` +
    'wire_api = "responses"\n\n';
  if (blockRe.test(text)) {
    text = text.replace(blockRe, desiredBlock);
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

function is9routerRunning(baseUrl = DEFAULT_BASE_URL) {
  return new Promise((resolve) => {
    const url = new URL(baseUrl);
    const req = http.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || 80,
        path: '/',
        timeout: 1500,
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

function loadDb(dbPath) {
  if (!fs.existsSync(dbPath)) {
    // Minimal shape if missing — preserves keys observed in real db.
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
    };
  }
  const raw = fs.readFileSync(dbPath, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('db.json không phải object');
    }
    if (!Array.isArray(parsed.providerConnections)) {
      parsed.providerConnections = [];
    }
    return parsed;
  } catch (e) {
    throw new Error(`Không đọc được db.json: ${e.message}`);
  }
}

function backupDb(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, '-');
  const bak = `${dbPath}.bak-${ts}`;
  fs.copyFileSync(dbPath, bak);
  return bak;
}

function saveDb(dbPath, db) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${dbPath}.tmp`;
  const json = JSON.stringify(db, null, 2);
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, dbPath);
}

// ---------------------------------------------------------------------------
// mergeEntries
//
// Skips entries whose email matches an existing codex entry (case-insensitive)
// OR whose accessToken matches an existing codex entry. Reassigns priority so
// new entries are appended at the end of the codex priority range.
// ---------------------------------------------------------------------------

function mergeEntries(db, entries, opts = {}) {
  const skipDuplicates = opts.skipDuplicates !== false;
  if (!Array.isArray(db.providerConnections)) db.providerConnections = [];
  const codexExisting = db.providerConnections.filter(
    (e) => e && e.provider === 'codex'
  );
  const existingEmails = new Set(
    codexExisting
      .map((e) => (e.name || '').toLowerCase().trim())
      .filter(Boolean)
  );
  const existingTokens = new Set(
    codexExisting.map((e) => e.accessToken).filter(Boolean)
  );

  let maxPriority = 0;
  for (const e of db.providerConnections) {
    if (e && e.provider === 'codex' && Number.isFinite(e.priority)) {
      if (e.priority > maxPriority) maxPriority = e.priority;
    }
  }

  const added = [];
  const skipped = [];
  for (const entry of entries) {
    const emailKey = (entry.name || '').toLowerCase().trim();
    if (
      skipDuplicates &&
      ((emailKey && existingEmails.has(emailKey)) ||
        existingTokens.has(entry.accessToken))
    ) {
      skipped.push(entry);
      continue;
    }
    maxPriority += 1;
    const e = { ...entry, priority: maxPriority };
    db.providerConnections.push(e);
    if (emailKey) existingEmails.add(emailKey);
    if (e.accessToken) existingTokens.add(e.accessToken);
    added.push(e);
  }

  return {
    added: added.length,
    skipped: skipped.length,
    addedEmails: added.map((e) => e.name),
    skippedEmails: skipped.map((e) => e.name),
  };
}

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
  const files = expandInputs(inputs);
  const parsed = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch (e) {
      parsed.push({ file: f, error: `Không đọc được file: ${e.message}` });
      continue;
    }
    const r = parseCodexFile(text);
    if (r.error) parsed.push({ file: f, error: r.error });
    else parsed.push({ file: f, entry: r.entry, source: r.source });
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
  let addedEmails = [];
  let skippedEmails = [];
  let writeError = null;
  let codexCliConfig = null;
  try {
    const db = loadDb(dbPath);
    const validEntries = parsed.filter((p) => p.entry).map((p) => p.entry);
    const merge = mergeEntries(db, validEntries, { skipDuplicates });
    added = merge.added;
    skipped = merge.skipped;
    addedEmails = merge.addedEmails;
    skippedEmails = merge.skippedEmails;

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
      `Đã ghi db.json — thêm ${added}, bỏ qua ${skipped} (trùng email/token).`
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
    addedEmails,
    skippedEmails,
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
  NINER_CLI,
  expandInputs,
  decodeJwtPayload,
  parseCodexFile,
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
  codexConfigPath,
  codexAuthPath,
};
