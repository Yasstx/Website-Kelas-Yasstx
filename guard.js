'use strict';
/**
 * Penjaga keamanan: blokir IP, catatan kejadian (tabel security_log), skor penyalahgunaan
 * dengan blokir otomatis, pembatas laju, dan batas koneksi SSE.
 * IP selalu dari clientIp() di util.js. Header X-Forwarded-For hanya dipercaya bila TRUST_PROXY diisi.
 */
require('./env');
const db = require('./db');
const { json, clientIp, isPrivate } = require('./util');

const PERMANEN = 253402300799000; // tahun 9999
const HARI = 864e5;
const LOG_DAYS = Math.max(1, parseInt(process.env.LOG_DAYS || '30', 10) || 30);
const ACCOUNT_DAYS = Math.max(7, parseInt(process.env.ACCOUNT_DAYS || '90', 10) || 90);
const LIMIT_GLOBAL = Math.max(60, parseInt(process.env.RATE_GLOBAL || '600', 10) || 600); // permintaan/menit/IP
const SSE_PER_IP = 60;   // WiFi sekolah dipakai bersama, jadi cukup longgar
const SSE_TOTAL = 600;

const SKOR_BATAS = 20;
const SKOR_JENDELA = 10 * 60 * 1000;
const BAN_OTOMATIS = 30 * 60 * 1000;
// Bobot kejadian: hanya sinyal yang jelas bermusuhan yang menambah skor.
const BOBOT = { bad_path: 5, probe: 5, bad_origin: 4, too_large: 4, login_fail: 3, bad_json: 2, bad_type: 2, bad_http: 2, bad_method: 1, sse_cap: 1, rate: 0.25 };
// Kejadian penting: selalu dicatat (tidak dibatasi 1 baris per 10 detik)
const SELALU = ['reg', 'leave', 'login_ok', 'login_lock', 'autoban', 'admin_op', 'akun_ban'];

const bans = new Map();   // ip -> { sampai, alasan }
const skor = new Map();   // ip -> [[waktu, bobot]]
const lastLog = new Map();
let dbSiap = false;
let menunggu = 0;
let sseTotal = 0;
const ssePer = new Map();

// ---------- pembatas laju ----------
function limiter(maks, jendelaMs) {
  const m = new Map();
  setInterval(() => {
    const now = Date.now();
    m.forEach((e, k) => { if (now - e.mulai >= jendelaMs) m.delete(k); });
  }, Math.max(jendelaMs, 60000)).unref();
  return function lewat(kunci) {
    const now = Date.now();
    let e = m.get(kunci);
    if (!e || now - e.mulai >= jendelaMs) {
      if (m.size > 100000) m.clear();
      e = { mulai: now, n: 0 };
      m.set(kunci, e);
    }
    e.n++;
    return e.n > maks;
  };
}
const batasGlobal = limiter(LIMIT_GLOBAL, 60000);

// ---------- blokir ----------
function dibanned(ip) {
  const b = bans.get(ip);
  if (!b) return false;
  if (b.sampai < Date.now()) { bans.delete(ip); return false; }
  return true;
}

function ban(ip, ms, alasan) {
  const sampai = ms ? Date.now() + ms : PERMANEN;
  alasan = String(alasan || '').slice(0, 120);
  bans.set(ip, { sampai: sampai, alasan: alasan });
  return db.pool.query('REPLACE INTO ip_ban (ip, sampai, alasan, t) VALUES (?,?,?,?)', [ip, sampai, alasan, Date.now()]);
}

function unban(ip) {
  bans.delete(ip);
  skor.delete(ip);
  return db.pool.query('DELETE FROM ip_ban WHERE ip = ?', [ip]);
}

function daftarBan() {
  const now = Date.now();
  const out = [];
  bans.forEach((b, ip) => { if (b.sampai >= now) out.push({ ip: ip, sampai: b.sampai, alasan: b.alasan, permanen: b.sampai === PERMANEN }); });
  return out.sort((a, b) => b.sampai - a.sampai);
}

// ---------- catatan kejadian ----------
function tulis(ip, ev, detail) {
  if (!dbSiap || menunggu > 300) return;
  menunggu++;
  const d = String(detail || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
  db.pool.query('INSERT INTO security_log (t, ip, ev, detail) VALUES (?,?,?,?)', [Date.now(), String(ip).slice(0, 45), ev, d])
    .catch(() => {})
    .finally(() => { menunggu--; });
}

function tambahSkor(ip, ev) {
  const w = BOBOT[ev];
  if (!w || bans.has(ip)) return;
  if (isPrivate(ip) && process.env.AUTOBAN_PRIVATE !== '1') return; // jangan blokir proxy/jaringan lokal secara tidak sengaja
  const now = Date.now();
  let a = skor.get(ip);
  if (!a) { a = []; skor.set(ip, a); }
  a.push([now, w]);
  while (a.length && now - a[0][0] > SKOR_JENDELA) a.shift();
  const total = a.reduce((s, x) => s + x[1], 0);
  if (total >= SKOR_BATAS) {
    skor.delete(ip);
    ban(ip, BAN_OTOMATIS, 'otomatis, skor ' + Math.round(total)).catch(() => {});
    tulis(ip, 'autoban', 'skor ' + Math.round(total) + ', diblokir ' + (BAN_OTOMATIS / 60000) + ' menit');
  }
}

function catat(ip, ev, detail) {
  tambahSkor(ip, ev);
  if (SELALU.indexOf(ev) === -1) {
    const kunci = ip + '|' + ev;
    const now = Date.now();
    if (now - (lastLog.get(kunci) || 0) < 10000) return;
    lastLog.set(kunci, now);
  }
  tulis(ip, ev, detail);
}
setInterval(() => {
  const now = Date.now();
  lastLog.forEach((t, k) => { if (now - t > 60000) lastLog.delete(k); });
  skor.forEach((a, ip) => { if (!a.length || now - a[a.length - 1][0] > SKOR_JENDELA) skor.delete(ip); });
}, 60000).unref();

// Dipakai chat.js dan panel.js saat readBody() gagal
function gagalBaca(req, res, err) {
  const peta = {
    too_large: [413, 'Permintaan terlalu besar.'],
    bad_origin: [403, 'Asal permintaan ditolak.'],
    bad_type: [415, 'Tipe konten harus JSON.'],
    bad_json: [400, 'Permintaan tidak valid.'],
    read_error: [400, 'Permintaan tidak valid.'],
  };
  const ev = peta[err.message] ? err.message : 'bad_json';
  catat(clientIp(req), ev === 'read_error' ? 'bad_json' : ev, String(req.url || '').slice(0, 80));
  json(res, peta[ev][0], { error: peta[ev][1] });
}

// ---------- batas koneksi SSE ----------
function sseBuka(ip) {
  if (sseTotal >= SSE_TOTAL || (ssePer.get(ip) || 0) >= SSE_PER_IP) return false;
  ssePer.set(ip, (ssePer.get(ip) || 0) + 1);
  sseTotal++;
  return true;
}
function sseTutup(ip) {
  const n = (ssePer.get(ip) || 0) - 1;
  if (n <= 0) ssePer.delete(ip); else ssePer.set(ip, n);
  sseTotal = Math.max(0, sseTotal - 1);
}

// ---------- baca log untuk panel ----------
async function ambilLog(ip, batas) {
  const n = Math.min(Math.max(parseInt(batas, 10) || 150, 1), 300);
  const [r] = ip
    ? await db.pool.query('SELECT id, t, ip, ev, detail FROM security_log WHERE ip = ? ORDER BY id DESC LIMIT ?', [ip, n])
    : await db.pool.query('SELECT id, t, ip, ev, detail FROM security_log ORDER BY id DESC LIMIT ?', [n]);
  return r.map((x) => ({ id: x.id, t: Number(x.t), ip: x.ip, ev: x.ev, detail: x.detail }));
}

// ---------- retensi data pribadi ----------
async function bersihkan() {
  const now = Date.now();
  const p = db.pool;
  try {
    await p.query('DELETE FROM security_log WHERE t < ?', [now - LOG_DAYS * HARI]);
    await p.query("UPDATE chat_messages SET ip = '' WHERE ip <> '' AND t < ?", [now - LOG_DAYS * HARI]);
    await p.query('DELETE FROM ip_ban WHERE sampai < ?', [now]);
    await p.query('DELETE FROM chat_accounts WHERE banned = 0 AND last_seen < ?', [now - ACCOUNT_DAYS * HARI]);
  } catch (e) { console.error('[guard] pembersihan gagal:', e.message); }
}

db.ready.then(async () => {
  const [r] = await db.pool.query('SELECT ip, sampai, alasan FROM ip_ban WHERE sampai > ?', [Date.now()]);
  r.forEach((x) => bans.set(x.ip, { sampai: Number(x.sampai), alasan: x.alasan }));
  dbSiap = true;
  bersihkan();
  setInterval(bersihkan, 6 * 3600 * 1000).unref();
  console.log('[guard] aktif. ' + bans.size + ' IP diblokir dimuat. Log disimpan ' + LOG_DAYS + ' hari.');
}).catch((e) => console.error('[guard] gagal start:', e.message));

module.exports = { limiter, batasGlobal, dibanned, ban, unban, daftarBan, catat, gagalBaca, sseBuka, sseTutup, ambilLog };
