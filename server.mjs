/* =====================================================================
   SideQuest local / long-lived server. Serves the static app AND the API.
     npm start            (PORT, SIDEQUEST_DATA, DATABASE_URL, VAPID_* env vars)

   Storage: PostgreSQL. With DATABASE_URL set it talks to that database;
   with none set it uses an embedded local PostgreSQL (PGlite) under
   SIDEQUEST_DATA/pg so `npm start` works out of the box.
   On Vercel the same logic runs from api/index.mjs instead (see vercel.json).
   ===================================================================== */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateVapid } from './webpush.mjs';
import { openDb, migrate } from './lib/db.mjs';
import { createApp } from './lib/app.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** VAPID keys come from the environment (required on serverless). Locally they are generated once into the data dir. */
export function loadVapid({ dataDir, env = process.env, allowFile = true } = {}) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY.replace(/\\n/g, '\n') };
  }
  if (!allowFile) return null;
  const file = path.join(dataDir, 'vapid.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    fs.mkdirSync(dataDir, { recursive: true });
    const v = generateVapid();
    fs.writeFileSync(file, JSON.stringify(v), { mode: 0o600 });
    return v;
  }
}

export async function startServer({
  port = Number(process.env.PORT) || 3000,
  dataDir = process.env.SIDEQUEST_DATA || path.join(ROOT, 'data'),
  databaseUrl = process.env.DATABASE_URL,
  memory = false,
  allowInsecurePush = process.env.SIDEQUEST_ALLOW_INSECURE_PUSH === '1',
  corsOrigin = process.env.SIDEQUEST_CORS_ORIGIN || '',
  subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  schedule = true,
  quiet = false
} = {}) {
  const db = await openDb({ url: databaseUrl, dataDir, memory });
  await migrate(db);
  const vapid = loadVapid({ dataDir });
  const app = createApp({
    db, vapid, subject, allowInsecurePush, corsOrigin,
    cronSecret: process.env.CRON_SECRET || '', trustProxy: process.env.TRUST_PROXY === '1',
    authIpMax: Number(process.env.SIDEQUEST_AUTH_IP_MAX) || 20
  });
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(port, r));
  const actualPort = server.address().port;
  const tick = schedule ? setInterval(() => app.runScheduler().catch(() => {}), 60000) : null;
  tick?.unref();
  if (!quiet) console.log(`SideQuest running on http://localhost:${actualPort}  (database: ${db.kind})`);
  return {
    server, port: actualPort, db, vapid, runScheduler: app.runScheduler,
    close: async () => { clearInterval(tick); await new Promise((r) => server.close(r)); await db.close(); }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startServer().catch((e) => { console.error(e.message); process.exit(1); });
}
