'use strict';
/**
 * Filter badword. Daftar kata ada di badwords.json (16.000+ entri).
 * Selain cocok persis, filter juga menangkap trik umum:
 *  - leetspeak (4nj1ng, @su), huruf diulang (anjinggg), huruf dipisah (a n j i n g),
 *    simbol di tengah kata (a.n.j.i.n.g), huruf beraksen.
 * Kata pendek (< 6 huruf) hanya dicek sebagai kata utuh agar kata biasa
 * (mis. "kelas", "assalamualaikum") tidak ikut terblokir.
 */
const fs = require('fs');
const path = require('path');

const LEET = { '4': 'a', '@': 'a', '3': 'e', '1': 'i', '!': 'i', '|': 'i', '0': 'o', '5': 's', '$': 's', '7': 't', '9': 'g', '8': 'b', '+': 't' };
const MIN_SUBSTR = 6;
const MAX_SUBSTR = 24;

function collapse(s) {
  return s.replace(/(.)\1+/g, '$1');
}

function strip(s) {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function leetToken(tok) {
  if (!/[a-z]/.test(tok)) return tok;
  let out = '';
  for (const ch of tok) out += LEET[ch] || ch;
  return out;
}

function loadWords() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'badwords.json'), 'utf8'));
  const exact = new Set();
  const long = new Set();
  for (const w of raw) {
    const lower = strip(String(w));
    // Varian leet (4nj1ng, @su) sudah ditangani saat input dinormalisasi, jadi hanya entri huruf murni yang dipakai
    if (!/^[a-z]+$/.test(lower)) continue;
    const c = collapse(lower);
    exact.add(lower);
    exact.add(c);
    if (c.length >= MIN_SUBSTR) long.add(c);
  }
  return { exact, long };
}

const WORDS = loadWords();

function tokens(text) {
  const parts = strip(text).split(/\s+/).filter(Boolean).map(leetToken);
  const res = [];
  let run = '';
  for (const p of parts) {
    const letters = p.replace(/[^a-z]/g, '');
    if (!letters) continue;
    if (letters.length === 1) { run += letters; continue; }
    if (run.length > 1) res.push(run);
    run = '';
    res.push(letters);
  }
  if (run.length > 1) res.push(run);
  return res;
}

function isClean(text) {
  if (!text) return true;
  if (text.length > 1000) return false; // batas pengaman CPU; chat sendiri dibatasi 300 karakter
  const toks = tokens(text);
  for (const t of toks) {
    if (WORDS.exact.has(t) || WORDS.exact.has(collapse(t))) return false;
  }
  const compact = collapse(toks.join(''));
  const n = compact.length;
  for (let i = 0; i < n; i++) {
    const maxLen = Math.min(MAX_SUBSTR, n - i);
    for (let len = MIN_SUBSTR; len <= maxLen; len++) {
      if (WORDS.long.has(compact.substr(i, len))) return false;
    }
  }
  return true;
}

module.exports = { isClean };
