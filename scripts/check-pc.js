'use strict';
const Database = require('C:\\Users\\Admin\\AppData\\Roaming\\9router\\runtime\\node_modules\\better-sqlite3');
const db = new Database('C:\\Users\\Admin\\AppData\\Roaming\\9router\\db\\data.sqlite', { readonly: true });
const rows = db.prepare('SELECT id,provider,authType,name,email,priority,isActive,data FROM providerConnections').all();
console.log('rows:', rows.length);
for (const r of rows) {
  let parsed = {};
  try { parsed = JSON.parse(r.data || '{}'); } catch {}
  console.log(JSON.stringify({
    id: r.id, provider: r.provider, name: r.name, email: r.email,
    priority: r.priority, isActive: r.isActive,
    expiresAt: parsed.expiresAt,
    plan: parsed.providerSpecificData?.chatgptPlanType,
    planSource: parsed.providerSpecificData?.planSource,
    refreshTail: parsed.refreshToken?.slice(-8),
  }));
}
db.close();
