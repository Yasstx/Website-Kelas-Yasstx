'use strict';
// Helper HTTP yang dipakai kemaan.js, chat.js, panel.js, dan guard.js
require('./env');
const net = require('net');

const MAX_BODY = 16384;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// TRUST_PROXY: 0 (bawaan, header proxy TIDAK dipercaya) | N (jumlah proxy di depan server) | cloudflare
const TRUST = String(process.env.TRUST_PROXY || '0').trim().toLowerCase();
const TRUST_HOPS = /^\d+$/.test(TRUST) ? parseInt(TRUST, 10) : 0;
const TRUST_CF = TRUST === 'cloudflare';
const BEHIND_PROXY = TRUST_HOPS > 0 || TRUST_CF;
const EXTRA_ORIGINS = String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function normIp(s) {
  s = String(s || '').trim().toLowerCase().replace(/%.*$/, '');
  if (s.indexOf('::ffff:') === 0 && net.isIPv4(s.slice(7))) s = s.slice(7);
  return net.isIP(s) ? s : '';
}

function clientIp(req) {
  const sock = normIp(req.socket && req.socket.remoteAddress) || 'unknown';
  if (TRUST_CF) {
    const cf = normIp(req.headers['cf-connecting-ip']);
    if (cf) return cf;
  } else if (TRUST_HOPS > 0) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const ip = normIp(xf[xf.length - TRUST_HOPS]);
    if (ip) return ip;
  }
  return sock;
}

function isPrivate(ip) {
  if (!ip || ip === 'unknown') return true;
  if (net.isIPv6(ip)) return ip === '::1' || /^f[cd]/.test(ip) || /^fe80/.test(ip);
  const p = ip.split('.').map(Number);
  return p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || p[0] === 0;
}

function isSecure(req) {
  if (req.socket && req.socket.encrypted) return true;
  if (!BEHIND_PROXY) return false;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

// Tolak permintaan lintas-situs (CSRF): Origin harus sama dengan Host (atau ada di ALLOWED_ORIGINS)
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  let host;
  try { host = new URL(o).host.toLowerCase(); } catch (e) { return false; }
  if (host === String(req.headers.host || '').toLowerCase()) return true;
  if (BEHIND_PROXY && host === String(req.headers['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase()) return true;
  return EXTRA_ORIGINS.indexOf(String(o).toLowerCase()) !== -1;
}

function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, Object.assign({}, SECURITY_HEADERS, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  }));
  res.end(body);
}

// cb(err, objek). err.message: bad_type | bad_origin | too_large | bad_json | read_error
function readBody(req, res, cb) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (ct.indexOf('application/json') !== 0) return cb(new Error('bad_type'));
  if (!sameOrigin(req)) return cb(new Error('bad_origin'));
  let size = 0;
  const chunks = [];
  let done = false;
  function stop(err) {
    if (done) return;
    done = true;
    if (err.message === 'too_large') {
      res.setHeader('Connection', 'close');
      res.once('finish', () => req.destroy());
    }
    cb(err);
  }
  if (parseInt(req.headers['content-length'] || '0', 10) > MAX_BODY) return stop(new Error('too_large'));
  req.on('data', (c) => {
    if (done) return;
    size += c.length;
    if (size > MAX_BODY) return stop(new Error('too_large'));
    chunks.push(c);
  });
  req.on('end', () => {
    if (done) return;
    done = true;
    let obj;
    try { obj = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { return cb(new Error('bad_json')); }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return cb(new Error('bad_json'));
    cb(null, obj);
  });
  req.on('error', () => stop(new Error('read_error')));
}

module.exports = { SECURITY_HEADERS, BEHIND_PROXY, json, readBody, clientIp, isPrivate, isSecure, normIp };
