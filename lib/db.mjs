/* Database access for SideQuest. One tiny interface, two drivers, identical SQL:
     - DATABASE_URL set  -> node-postgres pool (production: Supabase Postgres, Neon, RDS, ...)
     - otherwise         -> PGlite, an in-process PostgreSQL stored under SIDEQUEST_DATA/pg (local dev + tests)
   The interface:  db.query(sql, params) -> rows[]   db.tx(async (q) => ...)   db.exec(sql)   db.close() */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(HERE, '..', 'migrations');

export async function openDb({ url = process.env.DATABASE_URL, dataDir, memory = false } = {}) {
  let db;
  if (url) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: Number(process.env.PGPOOL_MAX) || 5 });
    db = {
      kind: 'postgres',
      query: async (sql, params = []) => (await pool.query(sql, params)).rows,
      exec: async (sql) => { await pool.query(sql); },
      tx: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query('begin');
          const out = await fn(async (sql, params = []) => (await c.query(sql, params)).rows);
          await c.query('commit');
          return out;
        } catch (e) { await c.query('rollback').catch(() => {}); throw e; }
        finally { c.release(); }
      },
      close: () => pool.end()
    };
  } else {
    let PGlite;
    try { ({ PGlite } = await import('@electric-sql/pglite')); }
    catch { throw new Error('No DATABASE_URL set and @electric-sql/pglite is not installed. Set DATABASE_URL, or run `npm install` to enable the local database.'); }
    let dir;
    if (!memory) { dir = path.join(dataDir || path.join(HERE, '..', 'data'), 'pg'); fs.mkdirSync(dir, { recursive: true }); }
    const lite = new PGlite(memory ? undefined : dir);
    await lite.waitReady;
    let chain = Promise.resolve();                       // PGlite is single-connection: serialise work
    const run = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
    db = {
      kind: 'pglite',
      query: (sql, params = []) => run(async () => (await lite.query(sql, params)).rows),
      exec: (sql) => run(() => lite.exec(sql)),
      tx: (fn) => run(() => lite.transaction((t) => fn(async (sql, params = []) => (await t.query(sql, params)).rows))),
      close: () => run(() => lite.close())
    };
  }
  return db;
}

/** Applies migrations/*.sql in filename order, once each. Returns the list applied this run. */
export async function migrate(db) {
  await db.exec('create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await db.query('select version from schema_migrations')).map((r) => r.version));
  const applied = [];
  for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    await db.tx(async (q) => {
      for (const stmt of splitSql(sql)) await q(stmt);
      await q('insert into schema_migrations(version) values ($1)', [f]);
    });
    applied.push(f);
  }
  return applied;
}

/* Statement splitter good enough for our own migration files (no $$ bodies, no semicolons inside strings). */
const splitSql = (sql) => sql.replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);

export const ms = (d) => (d ? new Date(d).getTime() : 0);
