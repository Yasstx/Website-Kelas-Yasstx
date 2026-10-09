'use strict';
/**
 * Koneksi MySQL + data kelas. Tabel dibuat otomatis saat server pertama jalan,
 * data awal diisi dari seed.json (sekali, saat tabel masih kosong).
 * Kredensial TIDAK ada di kode: isi lewat file .env atau variabel lingkungan
 * DB_HOST, DB_USER, DB_PASS, DB_NAME (opsional: DB_PORT, DB_SSL=1, DB_SSL_CA=/path/ca.pem).
 */
require('./env');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const kurang = ['DB_HOST', 'DB_USER', 'DB_PASS', 'DB_NAME'].filter((k) => !process.env[k]);
if (kurang.length) {
  console.error('[fatal] Belum diisi: ' + kurang.join(', ') + '. Salin .env.example jadi .env lalu isi kredensial database.');
  process.exit(1);
}

const ssl = process.env.DB_SSL === '1'
  ? Object.assign({ rejectUnauthorized: true }, process.env.DB_SSL_CA ? { ca: fs.readFileSync(process.env.DB_SSL_CA) } : {})
  : undefined;

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  ssl: ssl,
  waitForConnections: true,
  connectionLimit: 8,
  queueLimit: 200,
  connectTimeout: 10000,
  enableKeepAlive: true,
  charset: 'utf8mb4',
  dateStrings: true,
  multipleStatements: false,
});

const T = ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS chat_messages (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, nick VARCHAR(16) NOT NULL, text VARCHAR(300) NOT NULL, t BIGINT NOT NULL, aid INT UNSIGNED NOT NULL DEFAULT 0, ip VARCHAR(45) NOT NULL DEFAULT '', KEY idx_t (t))" + T,
  'CREATE TABLE IF NOT EXISTS chat_accounts (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, nick VARCHAR(16) NOT NULL, nick_key VARCHAR(16) NOT NULL, token_hash CHAR(64) NOT NULL, ip_first VARCHAR(45) NOT NULL, ip_last VARCHAR(45) NOT NULL, created BIGINT NOT NULL, last_seen BIGINT NOT NULL, msgs INT UNSIGNED NOT NULL DEFAULT 0, banned TINYINT(1) NOT NULL DEFAULT 0, UNIQUE KEY u_nick (nick_key), UNIQUE KEY u_tok (token_hash), KEY idx_seen (last_seen))' + T,
  "CREATE TABLE IF NOT EXISTS security_log (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, t BIGINT NOT NULL, ip VARCHAR(45) NOT NULL, ev VARCHAR(24) NOT NULL, detail VARCHAR(200) NOT NULL DEFAULT '', KEY idx_t (t), KEY idx_ip (ip, t))" + T,
  "CREATE TABLE IF NOT EXISTS ip_ban (ip VARCHAR(45) PRIMARY KEY, sampai BIGINT NOT NULL, alasan VARCHAR(120) NOT NULL DEFAULT '', t BIGINT NOT NULL)" + T,
  'CREATE TABLE IF NOT EXISTS kelas_data (k VARCHAR(32) PRIMARY KEY, v MEDIUMTEXT NOT NULL)' + T,
  "CREATE TABLE IF NOT EXISTS pengumuman (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, jenis VARCHAR(10) NOT NULL, judul VARCHAR(120) NOT NULL, mapel VARCHAR(40) NOT NULL DEFAULT '', isi VARCHAR(500) NOT NULL DEFAULT '', tenggat DATE NULL, dibuat BIGINT NOT NULL)" + T,
  'CREATE TABLE IF NOT EXISTS countdown (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, label VARCHAR(80) NOT NULL, waktu BIGINT NOT NULL)' + T,
];
// Kolom baru untuk database lama (tabel chat_messages versi sebelumnya)
const KOLOM_BARU = [
  ['chat_messages', 'aid', 'INT UNSIGNED NOT NULL DEFAULT 0'],
  ['chat_messages', 'ip', "VARCHAR(45) NOT NULL DEFAULT ''"],
];
const PUBLIC_KEYS = ['kelas', 'waliKelas', 'mapel', 'jadwal', 'piket', 'struktur', 'sosmed'];

function set(k, v) {
  return pool.query('REPLACE INTO kelas_data (k, v) VALUES (?, ?)', [k, JSON.stringify(v)]);
}

async function siapkan() {
  for (const q of SCHEMA) await pool.query(q);
  for (const [tabel, kolom, ddl] of KOLOM_BARU) {
    const [r] = await pool.query('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [tabel, kolom]);
    if (!r.length) await pool.query('ALTER TABLE ' + tabel + ' ADD COLUMN ' + kolom + ' ' + ddl);
  }
  const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM kelas_data');
  if (!c.n) {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
    for (const k of PUBLIC_KEYS) if (seed[k] !== undefined) await set(k, seed[k]);
    console.log('[db] Data awal kelas dimasukkan ke MySQL.');
  }
}

const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve setelah database siap. Kalau gagal, coba lagi sendiri (database bisa saja baru restart).
const ready = (async function init() {
  for (let i = 1; ; i++) {
    try { await siapkan(); console.log('[db] MySQL terhubung.'); return; }
    catch (e) {
      console.error('[db] Gagal menyiapkan MySQL (percobaan ' + i + '):', e.message);
      await tunggu(Math.min(30000, 2000 * i));
    }
  }
})();

let cache = null;
let cacheAt = 0;
let sedangMuat = null;

async function muat() {
  await Promise.race([ready, tunggu(8000).then(() => { throw new Error('db_belum_siap'); })]);
  const [kv] = await pool.query('SELECT k, v FROM kelas_data');
  const d = {};
  kv.forEach((r) => {
    if (PUBLIC_KEYS.indexOf(r.k) === -1) return;
    try { d[r.k] = JSON.parse(r.v); } catch (e) { /* baris rusak dilewati */ }
  });
  const [pg] = await pool.query('SELECT id, jenis, judul, mapel, isi, tenggat FROM pengumuman ORDER BY id DESC');
  const [cd] = await pool.query('SELECT id, label, waktu FROM countdown ORDER BY waktu');
  d.pengumuman = pg;
  d.countdown = cd.map((r) => ({ id: r.id, label: r.label, waktu: Number(r.waktu) }));
  cache = d;
  cacheAt = Date.now();
  return d;
}

// Satu pembacaan database untuk banyak permintaan bersamaan (cadangan 15 detik)
function getAll() {
  if (cache && Date.now() - cacheAt < 15000) return Promise.resolve(cache);
  if (!sedangMuat) sedangMuat = muat().finally(() => { sedangMuat = null; });
  return sedangMuat;
}

function invalidate() { cache = null; }

module.exports = { pool, ready, set, getAll, invalidate };
