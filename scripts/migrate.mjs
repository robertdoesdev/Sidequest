/* Usage: DATABASE_URL=postgres://... npm run migrate      (omit DATABASE_URL to migrate the local embedded DB) */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate } from '../lib/db.mjs';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = await openDb({ dataDir: process.env.SIDEQUEST_DATA || path.join(ROOT, 'data') });
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database already up to date.', `(${db.kind})`);
await db.close();
