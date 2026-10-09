'use strict';
/**
 * API pengelola (tersembunyi). Tidak ada tautan ke sini di halaman publik.
 * Semua rute di bawah /api/a/ selain login butuh token; tanpa token jawabannya 404.
 *  POST /api/a/login  {pass}            -> {token}
 *  POST /api/a/logout                   -> hapus sesi di server
 *  GET  /api/a/ui                       -> kode antarmuka panel (hanya untuk yang sudah login)
 *  GET  /api/a/sec[?ip=]                -> catatan kejadian, IP diblokir, daftar akun chat
 *  POST /api/a/save   {op, ...}         -> simpan perubahan
 * Kata sandi disimpan sebagai hash scrypt di MySQL. Saat pertama jalan dibuat otomatis
 * dan dicetak SEKALI di console. Mau pakai sendiri: isi ADMIN_PASS (minimal 12 karakter).
 * Opsional: ADMIN_ALLOW_IPS=1.2.3.4,5.6.7.8 membatasi panel hanya dari IP tersebut.
 */
require('./env');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const guard = require('./guard');
const { json, readBody, clientIp } = require('./util');

const HARI = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat'];
const TTL = 2 * 3600 * 1000;
const MIN_PASS = 12;
const ALLOW = String(process.env.ADMIN_ALLOW_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
const sessions = new Map(); // sha256(token) -> { exp, ip }
const gagal = new Map();    // ip -> [waktu gagal]
let gagalSemua = [];

class Bad extends Error {} // pesan Bad aman ditampilkan ke pengelola; kesalahan lain dijawab generik

const S = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const q = (sql, args) => db.pool.query(sql, args);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));
// Parameter scrypt sama dengan scryptSync bawaan, jadi hash lama tetap valid
const hashPass = (p, salt) => new Promise((ok, no) => {
  crypto.scrypt(p, salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? no(e) : ok(k.toString('hex'))));
});

function idValid(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw new Bad('ID tidak valid.');
  return n;
}

async function setPass(p) {
  const salt = crypto.randomBytes(16).toString('hex');
  await db.set('admin_hash', salt + ':' + (await hashPass(p, salt)));
}

async function cekPass(p) {
  p = String(p == null ? '' : p).slice(0, 256);
  const [r] = await q("SELECT v FROM kelas_data WHERE k = 'admin_hash'");
  if (!r.length) return false;
  const [salt, h] = JSON.parse(r[0].v).split(':');
  const a = Buffer.from(await hashPass(p, salt), 'hex');
  const b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

db.ready.then(async () => {
  const env = process.env.ADMIN_PASS;
  if (env) {
    if (env.length >= MIN_PASS) return setPass(env);
    console.error('[panel] ADMIN_PASS diabaikan: minimal ' + MIN_PASS + ' karakter.');
  }
  const [r] = await q("SELECT 1 FROM kelas_data WHERE k = 'admin_hash'");
  if (r.length) return;
  const p = crypto.randomBytes(12).toString('base64url');
  await setPass(p);
  console.log('\n=====================================================');
  console.log(' Kata sandi panel pengelola (hanya tampil sekali):');
  console.log('   ' + p);
  console.log(' Bisa diganti di panel, atau lewat variabel ADMIN_PASS.');
  console.log('=====================================================\n');
}).catch((e) => console.error('[panel] gagal menyiapkan kata sandi:', e.message));

function terkunci(ip) {
  const now = Date.now();
  gagalSemua = gagalSemua.filter((t) => now - t < 600000);
  const l = (gagal.get(ip) || []).filter((t) => now - t < 600000);
  gagal.set(ip, l);
  return l.length >= 5 || gagalSemua.length >= 30;
}

setInterval(() => {
  const now = Date.now();
  sessions.forEach((s, k) => { if (s.exp < now) sessions.delete(k); });
  gagal.forEach((l, ip) => { if (!l.length || now - l[l.length - 1] > 600000) gagal.delete(ip); });
}, 60000).unref();

// Mengembalikan hash token bila sesi sah, selain itu null
function sah(req) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const k = sha(m[1]);
  const s = sessions.get(k);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(k); return null; }
  return k;
}

const OPS = {
  async pg(b) {
    const jenis = ['PR', 'Ulangan', 'Info'].indexOf(b.jenis) > -1 ? b.jenis : 'Info';
    const judul = S(b.judul, 120);
    if (!judul) throw new Bad('Judul wajib diisi.');
    const tenggat = /^\d{4}-\d{2}-\d{2}$/.test(b.tenggat || '') ? b.tenggat : null;
    const v = [jenis, judul, S(b.mapel, 40), S(b.isi, 500), tenggat];
    if (b.id) await q('UPDATE pengumuman SET jenis=?, judul=?, mapel=?, isi=?, tenggat=? WHERE id=?', v.concat([idValid(b.id)]));
    else await q('INSERT INTO pengumuman (jenis, judul, mapel, isi, tenggat, dibuat) VALUES (?,?,?,?,?,?)', v.concat([Date.now()]));
  },
  async pgDel(b) { await q('DELETE FROM pengumuman WHERE id = ?', [idValid(b.id)]); },
  async cd(b) {
    const label = S(b.label, 80);
    const waktu = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(b.waktu || '') ? Date.parse(b.waktu + ':00+07:00') : NaN;
    if (!label) throw new Bad('Nama acara wajib diisi.');
    if (isNaN(waktu)) throw new Bad('Tanggal dan jam tidak valid.');
    if (b.id) await q('UPDATE countdown SET label=?, waktu=? WHERE id=?', [label, waktu, idValid(b.id)]);
    else await q('INSERT INTO countdown (label, waktu) VALUES (?, ?)', [label, waktu]);
  },
  async cdDel(b) { await q('DELETE FROM countdown WHERE id = ?', [idValid(b.id)]); },
  async jadwal(b) {
    if (HARI.indexOf(b.hari) === -1 || !Array.isArray(b.rows) || b.rows.length > 14) throw new Bad('Data jadwal tidak valid.');
    const d = await db.getAll();
    const rows = b.rows.map((r) => {
      if (!r || typeof r !== 'object') throw new Bad('Data jadwal tidak valid.');
      const o = { mulai: S(r.mulai, 5), selesai: S(r.selesai, 5), kode: S(r.kode, 20), guru: S(r.guru, 70) };
      if (!/^\d{2}:\d{2}$/.test(o.mulai) || !/^\d{2}:\d{2}$/.test(o.selesai) || o.mulai >= o.selesai) throw new Bad('Jam tidak valid (' + o.mulai + ' - ' + o.selesai + ').');
      if (!Object.prototype.hasOwnProperty.call(d.mapel, o.kode)) throw new Bad('Mapel tidak dikenal: ' + o.kode);
      return o;
    }).sort((x, y) => x.mulai.localeCompare(y.mulai));
    await db.set('jadwal', Object.assign({}, d.jadwal, { [b.hari]: rows }));
  },
  async piket(b) {
    const out = {};
    HARI.forEach((h) => {
      const l = Array.isArray(b.data && b.data[h]) ? b.data[h] : [];
      out[h] = l.map((n) => S(n, 40)).filter(Boolean).slice(0, 20);
    });
    await db.set('piket', out);
  },
  async info(b) {
    const w = S(b.waliKelas, 80);
    if (!w) throw new Bad('Nama wali kelas wajib diisi.');
    await db.set('waliKelas', w);
  },
  async pass(b, ctx) {
    if (!(await cekPass(b.lama))) throw new Bad('Kata sandi lama salah.');
    if (String(b.baru || '').length < MIN_PASS) throw new Bad('Kata sandi baru minimal ' + MIN_PASS + ' karakter.');
    await setPass(String(b.baru).slice(0, 256));
    sessions.forEach((s, k) => { if (k !== ctx.th) sessions.delete(k); }); // sesi lain otomatis keluar
  },
  async ban(b, ctx) {
    const ip = String(b.ip || '').trim();
    if (!net.isIP(ip)) throw new Bad('Alamat IP tidak valid.');
    if (ip === ctx.ip) throw new Bad('Tidak bisa memblokir IP-mu sendiri.');
    const jam = [1, 24, 168, 0].indexOf(Number(b.jam)) > -1 ? Number(b.jam) : 24;
    await guard.ban(ip, jam * 3600000, 'manual: ' + S(b.alasan, 60));
    guard.catat(ctx.ip, 'admin_op', 'blokir ' + ip + (jam ? ' ' + jam + ' jam' : ' permanen'));
  },
  async unban(b, ctx) {
    const ip = String(b.ip || '').trim();
    if (!net.isIP(ip)) throw new Bad('Alamat IP tidak valid.');
    await guard.unban(ip);
    guard.catat(ctx.ip, 'admin_op', 'buka blokir ' + ip);
  },
  async akunBan(b, ctx) {
    const id = idValid(b.id);
    const v = b.ban ? 1 : 0;
    await q('UPDATE chat_accounts SET banned = ? WHERE id = ?', [v, id]);
    guard.catat(ctx.ip, 'admin_op', (v ? 'blokir' : 'buka blokir') + ' akun #' + id);
  },
};

function handle(req, res, pathname, ip) {
  if (pathname.indexOf('/api/a/') !== 0) return false;
  ip = ip || clientIp(req);

  if (ALLOW.length && ALLOW.indexOf(ip) === -1) { json(res, 404, { error: 'Tidak ditemukan.' }); return true; }

  if (pathname === '/api/a/login' && req.method === 'POST') {
    if (terkunci(ip)) {
      guard.catat(ip, 'login_lock', 'terlalu banyak percobaan');
      json(res, 429, { error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
      return true;
    }
    readBody(req, res, async (err, b) => {
      if (err) return guard.gagalBaca(req, res, err);
      try {
        if (!(await cekPass(b.pass))) {
          let l = gagal.get(ip);
          if (!l) { l = []; gagal.set(ip, l); }
          l.push(Date.now());
          gagalSemua.push(Date.now());
          guard.catat(ip, 'login_fail', 'kata sandi salah');
          await tunggu(600);
          return json(res, 401, { error: 'Kode salah.' });
        }
        const token = crypto.randomBytes(24).toString('base64url');
        sessions.set(sha(token), { exp: Date.now() + TTL, ip: ip });
        guard.catat(ip, 'login_ok', 'masuk panel');
        json(res, 200, { token: token });
      } catch (e) { json(res, 503, { error: 'Database belum siap.' }); }
    });
    return true;
  }

  const th = sah(req);
  if (!th) { json(res, 404, { error: 'Tidak ditemukan.' }); return true; }

  if (pathname === '/api/a/logout' && req.method === 'POST') {
    sessions.delete(th);
    json(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/a/ui' && req.method === 'GET') {
    fs.readFile(path.join(__dirname, 'panel-ui.js'), (err, buf) => {
      if (err) return json(res, 500, { error: 'Antarmuka panel tidak ada.' });
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': buf.length });
      res.end(buf);
    });
    return true;
  }

  if (pathname === '/api/a/sec' && req.method === 'GET') {
    let f = '';
    try { f = new URL(req.url, 'http://x').searchParams.get('ip') || ''; } catch (e) { /* abaikan */ }
    Promise.all([
      guard.ambilLog(net.isIP(f) ? f : '', 200),
      q('SELECT id, nick, ip_first, ip_last, created, last_seen, msgs, banned FROM chat_accounts ORDER BY last_seen DESC LIMIT 200'),
    ]).then((r) => {
      json(res, 200, { log: r[0], akun: r[1][0], bans: guard.daftarBan() });
    }).catch((e) => { console.error('[panel] sec:', e.message); json(res, 500, { error: 'Gagal memuat data keamanan.' }); });
    return true;
  }

  if (pathname === '/api/a/save' && req.method === 'POST') {
    readBody(req, res, async (err, b) => {
      if (err) return guard.gagalBaca(req, res, err);
      const fn = Object.prototype.hasOwnProperty.call(OPS, b.op) ? OPS[b.op] : null;
      if (!fn) return json(res, 400, { error: 'Perintah tidak dikenal.' });
      try {
        await fn(b, { th: th, ip: ip });
        if (['ban', 'unban', 'akunBan'].indexOf(b.op) === -1) guard.catat(ip, 'admin_op', String(b.op).slice(0, 20));
        db.invalidate();
        json(res, 200, { ok: true });
      } catch (e) {
        if (e instanceof Bad) return json(res, 422, { error: e.message });
        console.error('[panel] ' + b.op + ':', e.message);
        json(res, 500, { error: 'Gagal menyimpan ke database.' });
      }
    });
    return true;
  }

  json(res, 404, { error: 'Tidak ditemukan.' });
  return true;
}

module.exports = { handle };
