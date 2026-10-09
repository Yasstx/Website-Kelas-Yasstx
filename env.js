'use strict';
// Muat file .env (tanpa dependensi). Variabel yang sudah ada di proses TIDAK ditimpa.
// Format: NAMA=nilai (satu per baris, tanpa komentar di ujung baris). Baris berawalan # diabaikan.
const fs = require('fs');
const path = require('path');

(function muat() {
  let raw;
  try { raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8'); } catch (e) { return; }
  raw.split(/\r?\n/).forEach((line) => {
    if (/^\s*#/.test(line)) return;
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) return;
    let v = m[2];
    if (v.length > 1 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  });
})();
