#!/usr/bin/env node
/*
 * 9router – ChatGPT/Codex Bulk Importer (CLI)
 * -------------------------------------------
 * Import hàng loạt file JSON OAuth của ChatGPT/Codex (mỗi file 1 tài khoản,
 * có id_token / access_token / refresh_token / account_id / email / expired)
 * thẳng vào db.json của 9router.
 *
 * Khác với Kiro importer: 9router KHÔNG có HTTP API cho codex, nên tool này
 * ghi trực tiếp vào %APPDATA%\9router\db.json. Vì DB được nạp vào memory,
 * 9router phải tắt trước khi ghi — dùng --force-stop để tự động xử lý.
 *
 * Không cần npm install — chỉ dùng module core của Node (≥ 18).
 *
 * USAGE
 *   node import.js                                # quét ./tokens/*.json
 *   node import.js file1.json file2.json          # các file cụ thể
 *   node import.js .\folder                       # toàn bộ *.json trong folder
 *   node import.js --list                         # dry-run, in preview, KHÔNG ghi
 *   node import.js --force-stop                   # dừng + khởi động lại 9router
 *   node import.js --no-restart                   # ghi nhưng không restart
 *   node import.js --no-configure-codex           # KHÔNG tự config Codex CLI
 *   node import.js --db D:\path\db.json           # chỉ định db.json khác
 *
 * Mặc định, sau khi import xong tool sẽ:
 *   - đảm bảo 9router có ít nhất 1 API key (tạo mới nếu cần)
 *   - ghi ~/.codex/config.toml (model_provider = "9router")
 *   - ghi ~/.codex/auth.json (auth_mode=apikey, OPENAI_API_KEY=<key>)
 * → Codex CLI dùng được ngay, không bị 401.
 *
 * EXIT CODES
 *   0  OK
 *   1  Không có file đầu vào hợp lệ
 *   3  Hoàn tất nhưng có ≥ 1 file không parse được
 *   4  9router đang chạy và không có --force-stop
 *   99 Lỗi không mong đợi
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_BASE_URL,
  DEFAULT_DB_PATH,
  expandInputs,
  parseCodexFile,
  bulkImport,
  is9routerRunning,
} = require('./importer-core');

// ---------- CLI args ----------
function parseArgs(argv) {
  const opts = {
    inputs: [],
    dry: false,
    forceStop: false,
    noRestart: false,
    configureCodex: true,
    dbPath: DEFAULT_DB_PATH,
    baseUrl: DEFAULT_BASE_URL,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list' || a === '--dry' || a === '--dry-run') opts.dry = true;
    else if (a === '--force-stop') opts.forceStop = true;
    else if (a === '--no-restart') opts.noRestart = true;
    else if (a === '--no-configure-codex' || a === '--no-codex-config')
      opts.configureCodex = false;
    else if (a === '--db') opts.dbPath = argv[++i];
    else if (a === '--url') opts.baseUrl = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else opts.inputs.push(a);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  process.stdout.write(
    fs.readFileSync(__filename, 'utf8').split('*/')[0] + '*/\n'
  );
  process.exit(0);
}

if (opts.inputs.length === 0) {
  const def = path.join(__dirname, 'tokens');
  if (fs.existsSync(def)) opts.inputs.push(def);
}

// ---------- pretty colors ----------
const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
const log = (...m) => console.log(...m);
const ok = (m) => `${c.green}✔${c.reset} ${m}`;
const bad = (m) => `${c.red}✘${c.reset} ${m}`;
const warn = (m) => `${c.yellow}!${c.reset} ${m}`;

function fmtSource(s) {
  if (!s) return '';
  const parts = [];
  if (s.email) parts.push(s.email);
  if (s.chatgptPlanType) parts.push(`plan=${s.chatgptPlanType}`);
  if (s.expiresAt) parts.push(`expires=${s.expiresAt}`);
  if (s.refreshTail) parts.push(`refresh…${s.refreshTail}`);
  return parts.join(' · ');
}

// ---------- main ----------
(async () => {
  log(`${c.bold}${c.cyan}9router – ChatGPT/Codex Bulk Importer${c.reset}`);
  log(`${c.dim}DB:${c.reset} ${opts.dbPath}`);
  log(`${c.dim}9router URL:${c.reset} ${opts.baseUrl}`);

  // Pre-list parsed files even outside dryRun so user sees something useful.
  const files = expandInputs(opts.inputs);
  if (files.length === 0) {
    log(bad('Không tìm thấy file .json nào để xử lý.'));
    log(
      `${c.dim}Đặt file vào: ${c.reset}${path.join(__dirname, 'tokens')} ` +
        `${c.dim}hoặc truyền đường dẫn ở dòng lệnh.${c.reset}`
    );
    process.exit(1);
  }

  log(`${c.dim}Tìm thấy ${files.length} file:${c.reset}`);
  let parseFails = 0;
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch (e) {
      log(`  ${bad(path.basename(f))} – ${c.red}đọc file lỗi: ${e.message}${c.reset}`);
      parseFails++;
      continue;
    }
    const r = parseCodexFile(text);
    if (r.error) {
      log(`  ${bad(path.basename(f))} – ${c.red}${r.error}${c.reset}`);
      parseFails++;
    } else {
      log(`  ${ok(path.basename(f))} – ${c.dim}${fmtSource(r.source)}${c.reset}`);
    }
  }

  if (opts.dry) {
    log(`\n${c.yellow}[--list] Dry-run, không ghi db.json.${c.reset}`);
    const running = await is9routerRunning(opts.baseUrl);
    log(
      `${c.dim}Trạng thái 9router:${c.reset} ${running ? c.green + 'đang chạy' + c.reset : c.gray + 'không chạy' + c.reset}`
    );
    process.exit(parseFails > 0 ? 3 : 0);
  }

  // Real import.
  log('');
  let result;
  try {
    result = await bulkImport({
      inputs: opts.inputs,
      dbPath: opts.dbPath,
      baseUrl: opts.baseUrl,
      forceStop: opts.forceStop,
      noRestart: opts.noRestart,
      configureCodex: opts.configureCodex,
      dryRun: false,
      log: (m) => log(`${c.dim}·${c.reset} ${m}`),
    });
  } catch (e) {
    log(bad(`Lỗi không mong đợi: ${e.stack || e.message}`));
    process.exit(99);
  }

  if (!result.ok) {
    log(bad(result.message || 'Thất bại'));
    if (result.code === 4) {
      log(
        `${c.dim}Mẹo: thêm ${c.reset}${c.bold}--force-stop${c.reset}${c.dim} để tool tự dừng & khởi động lại 9router.${c.reset}`
      );
    }
    process.exit(result.code || 99);
  }

  log('');
  log(
    `${c.bold}Hoàn tất:${c.reset} ` +
      `${c.green}+${result.added} thêm mới${c.reset}, ` +
      `${c.yellow}${result.skipped} bỏ qua (trùng)${c.reset}` +
      (result.backup ? `\n${c.dim}Backup:${c.reset} ${result.backup}` : '') +
      (result.wasRunning
        ? `\n${c.dim}9router restart:${c.reset} ${result.restarted ? c.green + 'OK' + c.reset : c.red + 'FAIL' + c.reset}`
        : `\n${c.dim}9router:${c.reset} ${c.gray}không chạy lúc import${c.reset}`)
  );
  if (result.addedEmails && result.addedEmails.length) {
    log(`${c.dim}Thêm:${c.reset} ${result.addedEmails.join(', ')}`);
  }
  if (result.skippedEmails && result.skippedEmails.length) {
    log(`${c.dim}Bỏ qua:${c.reset} ${result.skippedEmails.join(', ')}`);
  }
  if (result.codexCliConfig) {
    const cc = result.codexCliConfig;
    log(
      `${c.dim}Codex CLI:${c.reset} ${c.green}đã cấu hình${c.reset} ` +
        `(API key sk-…${cc.apiKey.slice(-6)}${cc.createdKey ? ' [mới tạo]' : ''})`
    );
    log(`${c.dim}  ${cc.configPath}${c.reset}`);
    log(`${c.dim}  ${cc.authPath}${c.reset}`);
  }
  process.exit(result.code || 0);
})().catch((e) => {
  console.error(`${c.red}✘ Lỗi không mong đợi:${c.reset} ${e.stack || e.message}`);
  process.exit(99);
});
