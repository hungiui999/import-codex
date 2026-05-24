#!/usr/bin/env node
/**
 * Giao diện web cục bộ cho ChatGPT/Codex Bulk Importer.
 * Chỉ lắng nghe 127.0.0.1, không cần npm install.
 *
 *   node gui.js [--port 3848]
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const {
  DEFAULT_DB_PATH,
  DEFAULT_BASE_URL,
  parseCodexFile,
  verifyChatgptPlan,
  bulkImport,
} = require('./importer-core');
const { readZipEntries } = require('./zip-reader');

const MAX_BODY = 32 * 1024 * 1024;

function parseArgs() {
  const a = process.argv.slice(2);
  let port = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--port' && a[i + 1]) port = parseInt(a[++i], 10) || 0;
  }
  return { port };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (ch) => {
      total += ch.length;
      if (total > MAX_BODY) {
        reject(new Error('Payload quá lớn'));
        req.destroy();
        return;
      }
      chunks.push(ch);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch (_) {
    /* ignore */
  }
}

const { port: requestedPort } = parseArgs();
const guiHtmlPath = path.join(__dirname, 'gui.html');
let guiHtml = '';
try {
  guiHtml = fs.readFileSync(guiHtmlPath, 'utf8');
} catch (e) {
  console.error('Không đọc được gui.html:', e.message);
  process.exit(1);
}

// Inject default db path placeholder so the field shows the actual resolved
// path without revealing it as a value.
const dbPathDisplay = DEFAULT_DB_PATH.replace(/\\/g, '\\\\').replace(/"/g, '&quot;');
const dbBackend = /\.sqlite$/i.test(DEFAULT_DB_PATH) ? 'sqlite' : 'json';
guiHtml = guiHtml.replace(
  'placeholder="%APPDATA%\\\\9router\\\\db.json"',
  `placeholder="${dbPathDisplay}" data-default="${dbPathDisplay}" data-backend="${dbBackend}"`
);

// Expand a list of incoming uploads. Each upload is { name, text?, zip? }
// where `zip` is a base64-encoded buffer for ZIP files. JSON files come
// through verbatim; ZIP files are decoded to N JSON entries server-side.
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
        entries = readZipEntries(buf, { filter: /\.json$/i });
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

// Pure parse for /api/parse — never touches DB.
async function parseUploads(uploads, { verifyPlanOnline = true } = {}) {
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
      }
    }
  }

  if (verifyTargets.length > 0) {
    await Promise.all(
      verifyTargets.map(async (row) => {
        try {
          const v = await verifyChatgptPlan({
            accessToken: row.source.accessToken,
            accountId: row.source.chatgptAccountId,
            timeoutMs: 6000,
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
      })
    );
  }

  // Strip transient accessToken from every row before returning to the UI.
  for (const row of rows) {
    if (row.source) delete row.source.accessToken;
  }
  return rows;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(guiHtml);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/parse') {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw);
      const uploads = Array.isArray(body.files)
        ? body.files.filter((f) => f && typeof f.name === 'string' && typeof f.text === 'string')
        : [];
      const rows = await parseUploads(uploads, {
        verifyPlanOnline: body.verifyPlanOnline !== false,
      });
      sendJson(res, 200, { ok: true, rows });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message || String(e) });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/import') {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw);
      const inputUploads = Array.isArray(body.files)
        ? body.files.filter(
            (f) =>
              f &&
              typeof f.name === 'string' &&
              (typeof f.text === 'string' || typeof f.zip === 'string')
          )
        : [];

      // Server-side expand: ZIP → N JSON uploads.
      const { uploads, errors: expandErrors } = expandUploads(inputUploads);

      if (uploads.length === 0) {
        sendJson(res, 200, {
          ok: false,
          message:
            expandErrors.length > 0
              ? `Không có file JSON hợp lệ (${expandErrors.length} file lỗi)`
              : 'Không có file JSON nào',
          parsed: expandErrors.map((e) => ({ name: e.name, error: e.error })),
        });
        return;
      }

      // Stage uploads to a temp folder so we can reuse bulkImport (which reads
      // from disk). Keeps a single code path between CLI and GUI.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '9router-codex-'));
      const stagedFiles = [];
      try {
        for (let i = 0; i < uploads.length; i++) {
          const u = uploads[i];
          const safe = (u.name || `upload-${i}.json`).replace(/[^\w.\-]+/g, '_');
          const p = path.join(tmpDir, `${i}_${safe}`);
          fs.writeFileSync(p, u.text, 'utf8');
          stagedFiles.push({ path: p, originalName: u.name });
        }

        const result = await bulkImport({
          inputs: stagedFiles.map((s) => s.path),
          dbPath: typeof body.dbPath === 'string' && body.dbPath ? body.dbPath : undefined,
          baseUrl: typeof body.baseUrl === 'string' && body.baseUrl ? body.baseUrl : DEFAULT_BASE_URL,
          forceStop: !!body.forceStop,
          noRestart: !!body.noRestart,
          verifyPlanOnline: body.verifyPlanOnline !== false,
          dryRun: false,
        });

        // Rewrite "file" field in parsed[] back to original upload names so the
        // UI shows the user's filenames, not staging paths.
        const byPath = new Map(stagedFiles.map((s) => [s.path, s.originalName]));
        const parsed = (result.parsed || []).map((p) => ({
          ...p,
          name: byPath.get(p.file) || (p.file ? path.basename(p.file) : ''),
        }));
        // Surface ZIP expand errors (corrupt zip etc.) at the top of the
        // parsed list so the UI shows them too.
        const allParsed = [
          ...expandErrors.map((e) => ({ name: e.name, error: e.error })),
          ...parsed,
        ];

        sendJson(res, 200, { ...result, parsed: allParsed });
      } finally {
        // Clean up staged files no matter what.
        try {
          for (const s of stagedFiles) {
            try { fs.unlinkSync(s.path); } catch (_) {}
          }
          fs.rmdirSync(tmpDir);
        } catch (_) { /* ignore */ }
      }
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message || String(e) });
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

server.on('error', (e) => {
  console.error(e.message || e);
  process.exit(1);
});

server.listen(requestedPort || 0, '127.0.0.1', () => {
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : requestedPort;
  const url = `http://127.0.0.1:${port}/`;
  console.log(`9router ChatGPT/Codex Importer — GUI: ${url}`);
  console.log('Nhấn Ctrl+C để thoát.');
  openBrowser(url);
});
