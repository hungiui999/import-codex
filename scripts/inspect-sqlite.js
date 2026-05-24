'use strict';
const path = require('path');
const Database = require('C:\\Users\\Admin\\AppData\\Roaming\\9router\\runtime\\node_modules\\better-sqlite3');
const dbPath = 'C:\\Users\\Admin\\AppData\\Roaming\\9router\\db\\data.sqlite';
const db = new Database(dbPath, { readonly: true });

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log('TABLES:');
for (const t of tables) console.log('  -', t.name);

const candidates = tables
  .map((t) => t.name)
  .filter((n) => /provider|connection|account|codex|oauth|apiKey/i.test(n));
console.log('\nLIKELY TABLES:', candidates);

for (const name of candidates) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${name})`).all();
    const count = db.prepare(`SELECT COUNT(*) c FROM ${name}`).get().c;
    console.log(`\n=== ${name} (rows=${count}) ===`);
    console.log(cols.map((c) => `${c.name}:${c.type}`).join(', '));
    if (count > 0) {
      const rows = db.prepare(`SELECT * FROM ${name} LIMIT 5`).all();
      for (let i = 0; i < rows.length; i++) {
        console.log(`row ${i}:`);
        for (const [k, v] of Object.entries(rows[i])) {
          if (k === 'data' && typeof v === 'string') {
            try {
              const parsed = JSON.parse(v);
              const summary = {};
              for (const [pk, pv] of Object.entries(parsed)) {
                summary[pk] = typeof pv === 'string' && pv.length > 60 ? pv.slice(0, 60) + '…' : pv;
              }
              console.log('  data:', JSON.stringify(summary));
            } catch {
              console.log('  data:', String(v).slice(0, 200));
            }
          } else {
            console.log(`  ${k}:`, typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : v);
          }
        }
      }
    }
  } catch (e) {
    console.log('  err:', e.message);
  }
}

// Also dump the kv & settings tables - these often hold the runtime config.
console.log('\n=== kv ===');
try {
  console.log(db.prepare('SELECT * FROM kv').all().slice(0, 20));
} catch (e) {
  console.log('  err:', e.message);
}
console.log('\n=== settings ===');
try {
  console.log(db.prepare('SELECT * FROM settings').all().slice(0, 5));
} catch (e) {
  console.log('  err:', e.message);
}

db.close();

