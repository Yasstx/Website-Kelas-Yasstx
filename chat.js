'use strict';
/**
 * Chat komunitas dengan akun. Akun dibuat lewat /api/chat/nick (IP pembuat dicatat) dan
 * mendapat token rahasia yang disimpan di perangkat. Pesan disimpan di MySQL (chat_messages)
 * beserta IP pengirim. IP hanya terlihat di panel pengelola, tidak pernah dikirim ke pengguna lain.
 *  GET  /api/chat/history  -> riwayat pesan terakhir
 *  GET  /api/chat/stream   -> Server-Sent Events, pesan baru muncul real-time
 *  POST /api/chat/nick     -> buat akun {nick} -> {nick, token, aid}
 *  POST /api/chat/send     -> kirim pesan {token, text}
 *  POST /api/chat/leave    -> hapus akun {token} (nickname bebas dipakai lagi)
 */
const crypto = require('crypto');
const { pool, ready } = require('./db');
const { json, readBody } = require('./util');
const guard = require('./guard');
const { isClean } = require('./filter');

const MAX_MESSAGES = 200;      // riwayat yang dimuat ke memori
const MAX_TEXT = 300;          // maksimal karakter per pesan
const NICK_RE = /^[A-Za-z0-9_ ]{3,16}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const MIN_GAP_MS = 1500;       // jeda minimal antar pesan per akun
const PER_MINUTE = 20;         // maksimal pesan per menit per akun
const sendIp = guard.limiter(120, 60000);       // pesan per menit per IP (WiFi sekolah dipakai bersama)
const regIp = guard.limiter(40, 3600000);       // percobaan buat akun per jam per IP
const regSemua = guard.limiter(400, 3600000);   // percobaan buat akun per jam, seluruh server

// Nickname yang meniru peran resmi. Dicocokkan setelah dinormalisasi (spasi, _, leet, huruf ganda dibuang).
const RESERVED_EXACT = ['admin', 'administrator', 'guru', 'wali', 'walikelas', 'system', 'sistem', 'moderator', 'mod', 'ketua', 'ketuakelas', 'bot', 'owner', 'staff', 'pengelola', 'operator', 'sekretaris', 'bendahara'];
const RESERVED_PREFIX = ['admin', 'moderator', 'system', 'sistem', 'walikelas', 'ketuakelas', 'pengelola'];
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b' };

let messages = [];
let siap = false;
const clients = new Map();     // res -> ip
const rate = new Map();        // aid -> { last, stamps[] }

ready.then(async () => {
  const [rows] = await pool.query('SELECT id, nick, text, t, aid FROM chat_messages ORDER BY id DESC LIMIT ?', [MAX_MESSAGES]);
  messages = rows.reverse().map((r) => ({ id: r.id, nick: r.nick, text: r.text, t: Number(r.t), aid: r.aid }));
  siap = true;
  console.log('[chat] ' + messages.length + ' pesan dimuat dari MySQL.');
}).catch((e) => console.error('[chat] gagal memuat riwayat:', e.message));

function tooFast(aid) {
  const now = Date.now();
  let r = rate.get(aid);
  if (!r) { r = { last: 0, stamps: [] }; rate.set(aid, r); }
  r.stamps = r.stamps.filter((t) => now - t < 60000);
  if (now - r.last < MIN_GAP_MS || r.stamps.length >= PER_MINUTE) return true;
  r.last = now;
  r.stamps.push(now);
  return false;
}
setInterval(() => {
  const now = Date.now();
  rate.forEach((r, k) => { if (now - r.last > 120000) rate.delete(k); });
}, 60000).unref();

function cleanText(s) {
  // buang karakter kontrol dan karakter tak terlihat (zero-width, bidi, pengisi Hangul), rapikan spasi
  return String(s || '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufeff\uffa0\ufff9-\ufffb]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nickKey(nick) {
  let k = '';
  for (const ch of nick.toLowerCase()) k += LEET[ch] || ch;
  return k.replace(/[ _]/g, '').replace(/(.)\1+/g, '$1');
}

function checkNick(raw) {
  const nick = cleanText(raw);
  if (!NICK_RE.test(nick) || nick.replace(/[^A-Za-z0-9]/g, '').length < 3) return { error: 'Nickname 3-16 karakter, hanya huruf, angka, spasi, dan garis bawah.' };
  const key = nickKey(nick);
  if (RESERVED_EXACT.indexOf(key) !== -1 || RESERVED_PREFIX.some((p) => key.indexOf(p) === 0)) return { error: 'Nickname itu dicadangkan, pilih yang lain.' };
  if (!isClean(nick)) return { error: 'Nickname mengandung kata yang tidak pantas.' };
  return { nick: nick, key: key };
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function broadcast(msg) {
  const data = 'id: ' + msg.id + '\ndata: ' + JSON.stringify(msg) + '\n\n';
  clients.forEach((ip, res) => { try { res.write(data); } catch (e) { clients.delete(res); } });
}

function handleStream(req, res, ip) {
  if (!guard.sseBuka(ip)) {
    guard.catat(ip, 'sse_cap', 'terlalu banyak koneksi stream');
    return json(res, 429, { error: 'Terlalu banyak koneksi.' });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  res.write('retry: 3000\n\n');
  clients.set(res, ip);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* ditutup */ } }, 25000);
  let tutup = false;
  req.on('close', () => {
    if (tutup) return;
    tutup = true;
    clearInterval(ping);
    clients.delete(res);
    guard.sseTutup(ip);
  });
}

// Bungkus callback async: kesalahan tak terduga jadi 503 generik, tidak membocorkan pesan internal
function aman(res, fn) {
  return (err, body) => {
    Promise.resolve().then(() => fn(err, body)).catch((e) => {
      console.error('[chat]', e && e.message);
      if (!res.headersSent) json(res, 503, { error: 'Server sibuk, coba lagi sebentar.' });
    });
  };
}

function handle(req, res, pathname, ip) {
  if (pathname.indexOf('/api/chat/') !== 0) return false;

  if (pathname === '/api/chat/history' && req.method === 'GET') {
    json(res, 200, { messages: messages, online: clients.size });
    return true;
  }
  if (pathname === '/api/chat/stream' && req.method === 'GET') {
    handleStream(req, res, ip);
    return true;
  }

  if (pathname === '/api/chat/nick' && req.method === 'POST') {
    readBody(req, res, aman(res, async (err, body) => {
      if (err) return guard.gagalBaca(req, res, err);
      if (regIp(ip) || regSemua('all')) {
        guard.catat(ip, 'rate', 'buat akun terlalu sering');
        return json(res, 429, { error: 'Terlalu banyak percobaan membuat akun. Coba lagi nanti.' });
      }
      if (!siap) return json(res, 503, { error: 'Chat belum siap, coba lagi sebentar.' });
      const n = checkNick(body.nick);
      if (n.error) {
        guard.catat(ip, 'reg_fail', String(cleanText(body.nick)).slice(0, 40) + ': ' + n.error.slice(0, 40));
        return json(res, 422, { error: n.error });
      }
      const token = crypto.randomBytes(24).toString('base64url');
      const now = Date.now();
      try {
        const [r] = await pool.query(
          'INSERT INTO chat_accounts (nick, nick_key, token_hash, ip_first, ip_last, created, last_seen) VALUES (?,?,?,?,?,?,?)',
          [n.nick, n.key, sha(token), ip, ip, now, now]
        );
        guard.catat(ip, 'reg', n.nick + ' (akun #' + r.insertId + ')');
        json(res, 200, { ok: true, nick: n.nick, token: token, aid: r.insertId });
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') return json(res, 409, { error: 'Nickname sudah dipakai, pilih yang lain.' });
        throw e;
      }
    }));
    return true;
  }

  if (pathname === '/api/chat/send' && req.method === 'POST') {
    readBody(req, res, aman(res, async (err, body) => {
      if (err) return guard.gagalBaca(req, res, err);
      if (sendIp(ip)) {
        guard.catat(ip, 'rate', 'kirim pesan (IP)');
        return json(res, 429, { error: 'Terlalu cepat, tunggu sebentar.' });
      }
      if (!siap) return json(res, 503, { error: 'Chat belum siap, coba lagi sebentar.' });
      const tok = String(body.token || '');
      if (!TOKEN_RE.test(tok)) return json(res, 401, { error: 'Akun tidak valid. Buat nickname lagi.', ulang: true });
      const [rows] = await pool.query('SELECT id, nick, banned FROM chat_accounts WHERE token_hash = ?', [sha(tok)]);
      if (!rows.length) return json(res, 401, { error: 'Akun tidak valid. Buat nickname lagi.', ulang: true });
      const acc = rows[0];
      if (acc.banned) {
        guard.catat(ip, 'akun_ban', acc.nick + ' (akun #' + acc.id + ') mencoba kirim pesan');
        return json(res, 403, { error: 'Akunmu diblokir oleh pengelola.' });
      }
      if (tooFast(acc.id)) {
        guard.catat(ip, 'rate', acc.nick + ' kirim terlalu cepat');
        return json(res, 429, { error: 'Terlalu cepat, tunggu sebentar.' });
      }
      const text = cleanText(body.text);
      if (!text) return json(res, 422, { error: 'Pesan kosong.' });
      if (text.length > MAX_TEXT) return json(res, 422, { error: 'Pesan maksimal ' + MAX_TEXT + ' karakter.' });
      if (!isClean(text)) {
        guard.catat(ip, 'badword', acc.nick + ': ' + text.slice(0, 80));
        return json(res, 422, { error: 'Pesan tidak terkirim: mengandung kata kasar.', badword: true });
      }
      const msg = { id: 0, nick: acc.nick, text: text, t: Date.now(), aid: acc.id };
      const [r] = await pool.query('INSERT INTO chat_messages (nick, text, t, aid, ip) VALUES (?, ?, ?, ?, ?)', [msg.nick, msg.text, msg.t, msg.aid, ip]);
      msg.id = r.insertId;
      pool.query('UPDATE chat_accounts SET last_seen = ?, ip_last = ?, msgs = msgs + 1 WHERE id = ?', [msg.t, ip, acc.id]).catch(() => {});
      messages.push(msg);
      if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);
      broadcast(msg);
      json(res, 200, { ok: true, id: msg.id });
    }));
    return true;
  }

  if (pathname === '/api/chat/leave' && req.method === 'POST') {
    readBody(req, res, aman(res, async (err, body) => {
      if (err) return guard.gagalBaca(req, res, err);
      const tok = String(body.token || '');
      if (TOKEN_RE.test(tok) && siap) {
        // akun yang diblokir tidak dihapus supaya blokirnya tidak bisa dihindari dengan "ganti nickname"
        const [r] = await pool.query('DELETE FROM chat_accounts WHERE token_hash = ? AND banned = 0', [sha(tok)]);
        if (r.affectedRows) guard.catat(ip, 'leave', 'akun dihapus oleh pemiliknya');
      }
      json(res, 200, { ok: true });
    }));
    return true;
  }

  json(res, 404, { error: 'Endpoint chat tidak ditemukan.' });
  return true;
}

// bersihkan pesan lama di MySQL (sisakan 5000 terakhir) tiap 6 jam
setInterval(() => {
  if (!siap) return;
  pool.query('DELETE FROM chat_messages WHERE id <= (SELECT m FROM (SELECT MAX(id) - 5000 AS m FROM chat_messages) x)').catch(() => {});
}, 6 * 3600 * 1000).unref();

function shutdown() {
  clients.forEach((ip, r) => { try { r.end(); } catch (e) { /* abaikan */ } });
}

module.exports = { handle, shutdown };
