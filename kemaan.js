'use strict';

/**
 * Web Kelas VIII.H - server Node.js + MySQL (satu-satunya dependensi: mysql2).
 * Port dibaca dari SERVER_PORT (Pterodactyl) atau PORT, default 3000.
 */
require('./env');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const guard = require('./guard');
const chat = require('./chat');
const panel = require('./panel');
const { SECURITY_HEADERS, BEHIND_PROXY, clientIp, isPrivate, isSecure } = require('./util');

const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const REAL_PUBLIC = fs.realpathSync(PUBLIC_DIR);
const FOTO_DIR = path.join(PUBLIC_DIR, 'foto');
const FOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
};

// Permintaan ke jalur yang tidak pernah ada di situs ini = pemindai/penyerang mencari celah
const PROBE = /^\/(wp-|wordpress|xmlrpc|phpmyadmin|pma|phpinfo|cgi-bin|vendor|boaform|actuator|server-status|admin|login|backup|dump|console|\.git|\.env|\.aws|\.ssh|\.svn)|\.(php\d?|asp|aspx|jsp|cgi|env|sql|bak|old|swp|ini|ya?ml|log|zip|rar|7z|tar|t?gz|pem|key|js|mjs|map|md)$/i;

function csp(nonce) {
  return "default-src 'none'; " +
    "script-src 'nonce-" + nonce + "'; " +
    "style-src 'nonce-" + nonce + "' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; " +
    "img-src 'self' data:; media-src 'self'; connect-src 'self'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";
}

function headers(req, extra) {
  const h = Object.assign({}, SECURITY_HEADERS, extra);
  if (isSecure(req)) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

function send(req, res, status, body, extra) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, headers(req, Object.assign({}, extra, { 'Content-Length': buf.length })));
  res.end(req.method === 'HEAD' ? undefined : buf);
}

const teks = (req, res, status, pesan, extra) => send(req, res, status, pesan, Object.assign({ 'Content-Type': MIME['.txt'] }, extra));

function sendJson(req, res, status, obj) {
  send(req, res, status, JSON.stringify(obj), { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
}

function serveData(req, res) {
  db.getAll().then(
    (d) => sendJson(req, res, 200, d),
    (e) => {
      console.error('[data]', e.message);
      sendJson(req, res, 503, { error: 'Database belum bisa diakses.' });
    }
  );
}

let fotoCache = { at: 0, foto: [] };
function serveFoto(req, res) {
  if (Date.now() - fotoCache.at < 30000) return sendJson(req, res, 200, { foto: fotoCache.foto });
  fs.readdir(FOTO_DIR, (err, files) => {
    if (err) return sendJson(req, res, 200, { foto: [] });
    const foto = files
      .filter((f) => FOTO_EXT.has(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, 'id', { numeric: true }))
      .map((f) => '/foto/' + encodeURIComponent(f));
    fotoCache = { at: Date.now(), foto: foto };
    sendJson(req, res, 200, { foto });
  });
}

// index.html disajikan lewat server supaya tiap respons punya nonce CSP sendiri
let htmlCache = { mtime: 0, txt: '' };
let peringatNonce = false;
function serveIndex(req, res) {
  const file = path.join(PUBLIC_DIR, 'index.html');
  fs.stat(file, (err, st) => {
    if (err) return teks(req, res, 404, 'Halaman tidak ditemukan');
    const kirim = () => {
      const nonce = crypto.randomBytes(16).toString('base64');
      const ada = htmlCache.txt.indexOf('__NONCE__') !== -1;
      if (!ada && !peringatNonce) { peringatNonce = true; console.error('[csp] index.html tidak berisi __NONCE__, CSP dimatikan.'); }
      send(req, res, 200, htmlCache.txt.split('__NONCE__').join(nonce), Object.assign(
        { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' },
        ada ? { 'Content-Security-Policy': csp(nonce) } : {}
      ));
    };
    if (st.mtimeMs === htmlCache.mtime) return kirim();
    fs.readFile(file, 'utf8', (e, txt) => {
      if (e) return teks(req, res, 500, 'Kesalahan server');
      htmlCache = { mtime: st.mtimeMs, txt: txt };
      kirim();
    });
  });
}

function streamFile(req, res, file, st, ext) {
  const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
  const h = { 'Content-Type': MIME[ext], 'Cache-Control': 'public, max-age=86400', ETag: etag, 'Last-Modified': st.mtime.toUTCString() };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers(req, { ETag: etag, 'Cache-Control': h['Cache-Control'] }));
    return res.end();
  }
  const total = st.size;
  let start = 0;
  let end = total - 1;
  let status = 200;

  // Dukungan Range untuk audio (wajib agar musik bisa diputar/di-loop di HP)
  if (ext === '.mp3') {
    h['Accept-Ranges'] = 'bytes';
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = parseInt(m[1], 10);
        if (m[2]) end = Math.min(parseInt(m[2], 10), total - 1);
      } else {
        start = Math.max(total - parseInt(m[2], 10), 0);
      }
      if (start > end || start >= total) {
        res.writeHead(416, headers(req, { 'Content-Range': 'bytes */' + total }));
        return res.end();
      }
      status = 206;
      h['Content-Range'] = 'bytes ' + start + '-' + end + '/' + total;
    }
  }
  h['Content-Length'] = total ? end - start + 1 : 0;
  res.writeHead(status, headers(req, h));
  if (req.method === 'HEAD' || !total) return res.end();
  const stream = fs.createReadStream(file, { start: start, end: end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function serveStatic(req, res, pathname, ip) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (e) {
    guard.catat(ip, 'bad_path', pathname.slice(0, 100));
    return teks(req, res, 400, 'Permintaan tidak valid');
  }
  if (rel.indexOf('\0') !== -1 || rel.indexOf('\\') !== -1) {
    guard.catat(ip, 'bad_path', rel.replace(/[\0\\]/g, '?').slice(0, 100));
    return teks(req, res, 400, 'Permintaan tidak valid');
  }
  if (rel === '/' || rel === '' || rel === '/index.html') return serveIndex(req, res);
  if (rel.split('/').some((s) => s.charAt(0) === '.')) { // ".." dan file tersembunyi
    guard.catat(ip, 'bad_path', rel.slice(0, 100));
    return teks(req, res, 404, 'Halaman tidak ditemukan');
  }
  const ext = path.extname(rel).toLowerCase();
  if (!MIME[ext]) return teks(req, res, 404, 'Halaman tidak ditemukan');

  const filePath = path.join(PUBLIC_DIR, rel);
  if (filePath.indexOf(PUBLIC_DIR + path.sep) !== 0) {
    guard.catat(ip, 'bad_path', rel.slice(0, 100));
    return teks(req, res, 403, 'Akses ditolak');
  }
  fs.realpath(filePath, (e, real) => {
    if (e || real.indexOf(REAL_PUBLIC + path.sep) !== 0) return teks(req, res, 404, 'Halaman tidak ditemukan');
    fs.stat(real, (err, st) => {
      if (err || !st.isFile()) return teks(req, res, 404, 'Halaman tidak ditemukan');
      streamFile(req, res, real, st, ext);
    });
  });
}

let peringatIp = false;
const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
  const ip = clientIp(req);
  try {
    if (guard.dibanned(ip)) return teks(req, res, 403, 'Akses ditolak', { Connection: 'close' });
    const m = req.method;
    if (m !== 'GET' && m !== 'HEAD' && m !== 'POST') {
      guard.catat(ip, 'bad_method', String(m).slice(0, 10));
      return teks(req, res, 405, 'Metode tidak diizinkan', { Allow: 'GET, HEAD, POST' });
    }
    if (guard.batasGlobal(ip)) {
      guard.catat(ip, 'rate', 'batas global');
      return teks(req, res, 429, 'Terlalu banyak permintaan', { 'Retry-After': '30' });
    }
    if (!peringatIp && !BEHIND_PROXY && isPrivate(ip) && ip !== '127.0.0.1' && ip !== '::1') {
      peringatIp = true;
      console.warn('[ip] Pengunjung terlihat dari IP privat ' + ip + '. Kalau situs ada di balik proxy/Cloudflare, isi TRUST_PROXY di .env agar IP asli tercatat.');
    }
    const raw = req.url || '/';
    if (raw.charAt(0) !== '/') {
      guard.catat(ip, 'bad_path', raw.slice(0, 100));
      return teks(req, res, 400, 'Permintaan tidak valid');
    }
    const pathname = raw.split('?')[0].split('#')[0];
    if (PROBE.test(pathname)) {
      guard.catat(ip, 'probe', pathname.slice(0, 100));
      return teks(req, res, 404, 'Halaman tidak ditemukan');
    }
    if (chat.handle(req, res, pathname, ip) || panel.handle(req, res, pathname, ip)) return;
    if (m !== 'GET' && m !== 'HEAD') {
      return teks(req, res, 405, 'Metode tidak diizinkan', { Allow: 'GET, HEAD' });
    }
    if (pathname === '/api/data') return serveData(req, res);
    if (pathname === '/api/foto') return serveFoto(req, res);
    if (pathname === '/healthz') return sendJson(req, res, 200, { status: 'ok' });
    return serveStatic(req, res, pathname, ip);
  } catch (e) {
    console.error('[error]', e);
    if (!res.headersSent) teks(req, res, 500, 'Kesalahan server');
  }
});

// Batas waktu melawan koneksi lambat (slowloris). Aliran SSE tidak terpengaruh.
server.headersTimeout = 10000;
server.requestTimeout = 20000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 500;

server.on('clientError', (err, socket) => {
  guard.catat(String(socket.remoteAddress || 'unknown').replace(/^::ffff:/, ''), 'bad_http', String(err && err.code).slice(0, 40));
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  else socket.destroy();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('[fatal] Port ' + PORT + ' sedang dipakai. Ganti port di tab Network Pterodactyl.');
  } else {
    console.error('[fatal]', err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('[web-kelas-8h] Server berjalan di http://' + HOST + ':' + PORT);
});

function shutdown(signal) {
  console.log('[web-kelas-8h] ' + signal + ' diterima, menutup server...');
  chat.shutdown();
  db.pool.end().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
