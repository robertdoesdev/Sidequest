/* Vercel serverless entry: every /api/* request lands here (see vercel.json).
   Requires DATABASE_URL. The schema is created ahead of time with `npm run migrate`, not on request. */
import { openDb } from '../lib/db.mjs';
import { createApp } from '../lib/app.mjs';
import { loadVapid } from '../server.mjs';

let ready;
function boot() {
  return (ready ||= (async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    const db = await openDb({ url: process.env.DATABASE_URL });
    const vapid = loadVapid({ allowFile: false });          // serverless disk is ephemeral: VAPID must come from env vars
    return createApp({
      db, vapid, subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
      corsOrigin: process.env.SIDEQUEST_CORS_ORIGIN || '', cronSecret: process.env.CRON_SECRET || '',
      trustProxy: true                                       // Vercel sets x-forwarded-for
    });
  })().catch((e) => { ready = null; throw e; }));
}

export default async function handler(req, res) {
  try {
    const app = await boot();
    await app.handle(req, res, { serveFiles: false });
  } catch (e) {
    console.error('[boot error]', e.message);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'The service is not configured yet.' }));
  }
}
