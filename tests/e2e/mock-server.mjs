/* DEV-ONLY harness (not part of the product). Serves the static app and a tiny in-memory stand-in for the
   API so the front end can be driven in a real browser when the real database package isn't installed.
   It re-implements ONLY the friend-request ownership/state rules faithfully; it does NOT prove the real server. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

export function startMock({ port = 0, delay = 350 } = {}) {
  const db = {
    me: { username: 'ana', displayName: 'Ana A', bio: 'Collects weird facts', avatar: '', profilePublic: true, created: Date.now() - 9e8 },
    people: { ben: { username: 'ben', displayName: 'Ben', avatar: 'fox' }, cat: { username: 'cat', displayName: process.env.HOSTILE ? '"><img src=x onerror="window.__xss=1"><b>' : 'Cat', avatar: '' }, dan: { username: 'dan', displayName: 'Dan', avatar: 'owl' } },
    pending: ['ben', 'cat'],            // incoming to ana
    friends: ['dan'],
    calls: { respond: [], patch: [] },
    state: null
  };
  const personList = (names) => names.map((n) => db.people[n]);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname.startsWith('/api/')) {
      let raw = ''; for await (const c of req) raw += c;
      let b = {}; try { b = JSON.parse(raw || '{}'); } catch {}
      const authed = (req.headers.authorization || '') === 'Bearer tok';
      const p = url.pathname;
      if (p === '/api/health') return json(200, { ok: true, db: 'mock', push: { publicKey: '' } });
      if (!authed && p !== '/api/__calls') return json(401, { error: 'Sign in first.' });
      if (p === '/api/__calls') return json(200, db.calls);
      if (p === '/api/me' && req.method === 'GET') return json(200, { user: db.me });
      if (p === '/api/me' && req.method === 'PATCH') { db.calls.patch.push(b); db.me = { ...db.me, ...b }; return json(200, { user: db.me }); }
      if (p === '/api/state') return json(200, req.method === 'GET' ? { state: db.state } : (db.state = b.state, { ok: true }));
      if (p === '/api/friends') return json(200, { friends: personList(db.friends), incoming: personList(db.pending), outgoing: [] });
      if (p === '/api/challenges') return json(200, { challenges: [], waiting: 0 });
      if (p === '/api/blocks') return json(200, { blocked: [] });
      if (p === '/api/friends/respond') {
        db.calls.respond.push(b);
        await new Promise((r) => setTimeout(r, delay));
        if (typeof b.accept !== 'boolean') return json(400, { error: 'Say whether to accept or reject.' });
        if (!db.pending.includes(b.username)) return json(404, { error: 'No such request.' });     // not pending / not mine
        db.pending = db.pending.filter((x) => x !== b.username);
        if (b.accept) db.friends.push(b.username);
        return json(200, { ok: true });
      }
      let m;
      if ((m = /^\/api\/profiles\/([a-z0-9_]+)$/.exec(p))) {
        const u = db.people[m[1]] || (m[1] === 'ana' ? db.me : null);
        if (!u) return json(404, { error: 'Not found' });
        const f = m[1] === 'ana' ? 'self' : db.friends.includes(m[1]) ? 'friends' : db.pending.includes(m[1]) ? 'incoming' : 'none';
        return json(200, { profile: { username: u.username, displayName: u.displayName, bio: 'Hello there', avatar: u.avatar || '', joined: Date.now() - 5e8, profilePublic: true, stats: { shared: 2 } }, friendship: f });
      }
      if (/^\/api\/profiles\/[a-z0-9_]+\/posts$/.test(p) || p === '/api/showcase')
        return json(200, { posts: [{ id: 1, questId: '170', reflection: 'Loved it', note: 'Gerald loved it', completedAt: Date.now() - 1e6, mine: false, author: db.people.ben }], next: null });
      return json(404, { error: 'nope' });
    }
    let rel = decodeURIComponent(url.pathname); if (rel === '/') rel = '/index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ port: server.address().port, db, close: () => new Promise((c) => server.close(c)) })));
}
if (process.argv[1] && process.argv[1].endsWith('mock-server.mjs')) { const s = await startMock({ port: 4173 }); console.log('mock on', s.port); }
