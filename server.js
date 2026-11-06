// Tournament Bracket Maker - 同期サーバー (依存パッケージなし / Node.js 18+)
//   起動:  node server.js            (管理者パスワードは起動時に表示。固定したい場合は ADMIN_PASSWORD=xxxx node server.js)
//   観戦者: http://<このPCのIP>:8080/      → 閲覧専用(リアルタイム更新)
//   管理者: 同じURLを開き、画面の「🔒 管理者ログイン」からパスワードを入力
//
//   GET  /api/state    現在の大会データ (誰でも)
//   GET  /api/stream   Server-Sent Events: 更新があるたびに全データを配信 (誰でも)
//   POST /api/login    パスワード確認 (Authorization: Bearer <password>)
//   POST /api/state    大会データの更新 (管理者のみ)
//   DELETE /api/state  大会データの削除 (管理者のみ)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PASS_FILE = path.join(DATA_DIR, 'admin-password.txt');
const PORT = Number(process.env.PORT) || 8080;
const MAX_BODY = 12 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- 管理者パスワード ----
function loadPassword() {
  if (process.env.ADMIN_PASSWORD) return { pw: process.env.ADMIN_PASSWORD, src: '環境変数 ADMIN_PASSWORD' };
  try {
    const p = fs.readFileSync(PASS_FILE, 'utf8').trim();
    if (p) return { pw: p, src: PASS_FILE };
  } catch (e) { /* 初回 */ }
  const pw = crypto.randomBytes(6).toString('base64url');
  fs.writeFileSync(PASS_FILE, pw + '\n', { mode: 0o600 });
  return { pw, src: PASS_FILE + ' (新規作成)' };
}
const { pw: ADMIN_PW, src: PW_SRC } = loadPassword();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const ADMIN_HASH = sha(ADMIN_PW);
const isAdmin = (req) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return !!m && crypto.timingSafeEqual(sha(m[1]), ADMIN_HASH);
};

// ログイン総当たり対策: IPごとに1分で10回まで失敗を許可
const fails = new Map();
function throttled(ip) {
  const now = Date.now();
  const arr = (fails.get(ip) || []).filter((t) => now - t < 60000);
  fails.set(ip, arr);
  return arr.length >= 10;
}
const noteFail = (ip) => { const a = fails.get(ip) || []; a.push(Date.now()); fails.set(ip, a); };

// ---- 状態 ----
let current = { state: null, live: {}, rev: 0, updatedAt: 0 };
try { current = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { /* なし */ }
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(current), (err) => { if (!err) fs.rename(tmp, STATE_FILE, () => {}); });
  }, 300);
}

const clients = new Set();
function broadcast() {
  const msg = `data: ${JSON.stringify(current)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000).unref();

// ---- 静的ファイル (公開してよいものだけ) ----
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.json': 'application/json',
};
const PUBLIC_TOP = new Set(['index.html', 'styles.css', 'logo.png', 'mc', 'icon']);
const isPublic = (rel) => {
  const top = rel.split('/')[0];
  return PUBLIC_TOP.has(top) || /^earth_[\w]+\.jpg$/.test(rel);
};
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) || !isPublic(path.relative(ROOT, file).split(path.sep).join('/'))) {
    res.writeHead(404); return res.end('Not found');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const type = MIME[path.extname(file).toLowerCase()];
    if (!type) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const ip = req.socket.remoteAddress;
  try {
    if (p === '/api/state' && req.method === 'GET') return json(res, 200, current);

    if (p === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      res.write(`data: ${JSON.stringify(current)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (p === '/api/login' && req.method === 'POST') {
      if (throttled(ip)) return json(res, 429, { error: 'too many attempts' });
      if (isAdmin(req)) return json(res, 200, { ok: true });
      noteFail(ip);
      return json(res, 401, { error: 'unauthorized' });
    }

    if (p === '/api/state' && (req.method === 'POST' || req.method === 'DELETE')) {
      if (throttled(ip)) return json(res, 429, { error: 'too many attempts' });
      if (!isAdmin(req)) { noteFail(ip); return json(res, 401, { error: 'unauthorized' }); }
      if (req.method === 'DELETE') {
        current = { state: null, live: {}, rev: current.rev + 1, updatedAt: Date.now() };
      } else {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch (e) {
          return json(res, e.code === 413 ? 413 : 400, { error: 'bad body' });
        }
        const s = body && body.state;
        if (!s || s.kind !== 'bracket-maker-save' || !Array.isArray(s.matches)) return json(res, 400, { error: 'bad state' });
        current = { state: s, live: (body.live && typeof body.live === 'object') ? body.live : {}, rev: current.rev + 1, updatedAt: Date.now() };
      }
      persist();
      broadcast();
      return json(res, 200, { ok: true, rev: current.rev });
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
    res.writeHead(405); res.end('Method not allowed');
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: 'server error' }); else res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('\n=== Tournament Bracket Maker サーバー起動 ===');
  console.log(`  このPC     : http://localhost:${PORT}/`);
  lan.forEach((a) => console.log(`  同じWi-Fi内: http://${a}:${PORT}/`));
  console.log(`  管理者パスワード: ${ADMIN_PW}   (${PW_SRC})`);
  console.log('  観戦者はURLを開くだけ(閲覧専用)。あなたは画面の「🔒 管理者ログイン」から入力。\n');
});
