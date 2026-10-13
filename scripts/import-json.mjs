/* One-off, non-destructive import of the legacy JSON backend (data/db.json) into PostgreSQL.
   Usage: [DATABASE_URL=...] node scripts/import-json.mjs [path/to/db.json]
   - Accounts keep their original scrypt salt+hash, so existing passwords keep working.
   - Existing rows are never overwritten (ON CONFLICT DO NOTHING); re-running is safe.
   - Old login sessions are NOT imported: everyone signs in once more. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate } from '../lib/db.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] || path.join(process.env.SIDEQUEST_DATA || path.join(ROOT, 'data'), 'db.json');
const old = JSON.parse(fs.readFileSync(file, 'utf8'));
const db = await openDb({ dataDir: process.env.SIDEQUEST_DATA || path.join(ROOT, 'data') });
await migrate(db);

const ids = {};
let n = { users: 0, friends: 0, challenges: 0, push: 0 };
await db.tx(async (q) => {
  for (const u of Object.values(old.users || {})) {
    const r = await q(
      `insert into users(username, display_name, pass_salt, pass_hash, created_at)
       values ($1, $2, $3, $4, to_timestamp($5::float8 / 1000)) on conflict (username) do nothing returning id`,
      [u.username, u.displayName || u.username, u.pass.salt, u.pass.hash, u.created || Date.now()]);
    ids[u.username] = r[0]?.id ?? (await q('select id from users where username = $1', [u.username]))[0].id;
    if (r[0]) n.users++;
    if (u.state) await q('insert into user_state(user_id, state, updated_at) values ($1, $2::jsonb, to_timestamp($3::float8 / 1000)) on conflict do nothing', [ids[u.username], JSON.stringify(u.state), u.stateAt || Date.now()]);
  }
  for (const f of Object.values(old.friends || {})) {
    if (!ids[f.a] || !ids[f.b]) continue;
    const [x, y] = ids[f.a] < ids[f.b] ? [ids[f.a], ids[f.b]] : [ids[f.b], ids[f.a]];
    const r = await q('insert into friendships(user_a, user_b, requester, status) values ($1, $2, $3, $4) on conflict do nothing returning 1', [x, y, ids[f.from], f.status]);
    if (r.length) n.friends++;
  }
  for (const c of Object.values(old.challenges || {})) {
    if (!ids[c.from] || !ids[c.to]) continue;
    const r = await q(
      `insert into challenges(id, from_user, to_user, quest_id, message, status, from_done_at, to_done_at, created_at, updated_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9::float8 / 1000), to_timestamp($10::float8 / 1000), now() + interval '14 days')
       on conflict do nothing returning 1`,
      [c.id, ids[c.from], ids[c.to], c.questId, c.message || '', c.status, c.fromDone ? new Date(c.fromDone) : null, c.toDone ? new Date(c.toDone) : null, c.created || Date.now(), c.updated || Date.now()]);
    if (r.length) n.challenges++;
  }
  for (const [un, rec] of Object.entries(old.push || {})) {
    if (!ids[un]) continue;
    for (const s of rec.subs || []) await q('insert into push_subscriptions(endpoint, user_id, sub) values ($1, $2, $3::jsonb) on conflict do nothing', [s.endpoint, ids[un], JSON.stringify(s)]);
    await q('insert into push_settings(user_id, prefs, tz_offset, sent) values ($1, $2::jsonb, $3, $4::jsonb) on conflict do nothing', [ids[un], JSON.stringify(rec.prefs || {}), rec.tzOffset || 0, JSON.stringify(rec.sent || {})]);
    n.push++;
  }
});
console.log('Imported (new rows only):', n);
await db.close();
