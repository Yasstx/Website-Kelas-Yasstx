/* Antarmuka panel pengelola. Hanya dikirim server setelah login berhasil (/api/a/ui). */
(function () {
  'use strict';
  var HARI = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat'];
  var D = null, root, body, tab = 'pg', edit = null, hari = 'Senin', toastT;

  var css = document.createElement('style');
  css.nonce = window.__nonce || '';
  css.textContent =
    '.pn{position:fixed;inset:0;z-index:60;background:var(--bg);color:var(--teks);display:flex;flex-direction:column;font:15px/1.5 Inter,system-ui,sans-serif}' +
    '.pn-top{display:flex;align-items:center;gap:10px;padding:12px 16px;background:var(--hijau-tua);color:#fff}' +
    '.pn-top b{font:700 1.05rem Poppins,sans-serif;flex:1}' +
    '.pn-tabs{display:flex;gap:6px;padding:10px 16px;overflow-x:auto;border-bottom:1px solid var(--border);background:var(--putih)}' +
    '.pn-body{flex:1;overflow-y:auto;padding:16px;max-width:760px;width:100%;margin:0 auto}' +
    '.pn button{font:inherit;font-weight:600;cursor:pointer;border-radius:10px;border:1px solid var(--border);background:var(--putih);color:var(--teks);padding:8px 14px}' +
    '.pn button.on,.pn button.pri{background:var(--hijau);border-color:var(--hijau);color:#fff}' +
    '.pn button.bhs{color:#c0392b}' +
    '.pn-top button{background:transparent;color:#fff;border-color:rgba(255,255,255,.4)}' +
    '.pn input,.pn select,.pn textarea{font:inherit;width:100%;padding:9px 11px;border:1px solid var(--border);border-radius:10px;background:var(--putih);color:var(--teks)}' +
    '.pn textarea{min-height:92px;resize:vertical}' +
    '.pn label{display:block;margin-bottom:10px}.pn label>span{display:block;font-size:.8rem;font-weight:600;color:var(--muted);margin-bottom:3px}' +
    '.pn-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}' +
    '.pn-box{background:var(--putih);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:12px}' +
    '.pn-it{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)}.pn-it:last-child{border:0}' +
    '.pn-it small{display:block;color:var(--muted)}' +
    '.pn-act{display:flex;gap:6px;flex:none}' +
    '.pn-jd{display:grid;grid-template-columns:86px 86px 1fr;gap:6px;margin-bottom:6px}' +
    '.pn-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#12291c;color:#fff;padding:10px 18px;border-radius:999px;font-weight:600;z-index:70}' +
    '.pn-toast.err{background:#b3261e}' +
    '@media(max-width:520px){.pn-row{grid-template-columns:1fr}}';
  document.head.appendChild(css);

  function h(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
  function btn(txt, cls, fn) { var b = h('button', cls, txt); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function fld(lbl, input) { var w = h('label'); w.appendChild(h('span', '', lbl)); w.appendChild(input); return w; }
  function inp(type, val, max) { var i = h('input'); i.type = type; i.value = val || ''; if (max) i.maxLength = max; return i; }
  function sel(opts, val) {
    var s = h('select');
    opts.forEach(function (o) { var p = h('option', '', o[1]); p.value = o[0]; s.appendChild(p); });
    s.value = val; return s;
  }
  function toast(msg, err) {
    clearTimeout(toastT);
    var o = document.querySelector('.pn-toast'); if (o) o.remove();
    var t = h('div', 'pn-toast' + (err ? ' err' : ''), msg); document.body.appendChild(t);
    toastT = setTimeout(function () { t.remove(); }, 2600);
  }

  function api(op, b) {
    b = b || {}; b.op = op;
    return fetch('/api/a/save', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + window.__tok }, body: JSON.stringify(b) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'Gagal menyimpan.'); return d; }); })
      .then(function () { return muat(); })
      .then(function () { window.dispatchEvent(new Event('k8h-refresh')); toast('Tersimpan'); })
      .catch(function (e) { toast(e.message, true); throw e; });
  }
  function muat() {
    return fetch('/api/data', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) { D = d; draw(); });
  }
  function tutup() { root.remove(); document.querySelector('.pn-toast') && document.querySelector('.pn-toast').remove(); }

  function draw() {
    root.querySelectorAll('.pn-tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.t === tab); });
    body.textContent = '';
    ({ pg: vPg, cd: vCd, jd: vJd, pk: vPk, ak: vAk, sc: vSc })[tab]();
  }

  function item(judul, sub, onEdit, onDel) {
    var r = h('div', 'pn-it'), t = h('div'); t.appendChild(h('b', '', judul)); t.appendChild(h('small', '', sub));
    var a = h('div', 'pn-act');
    a.appendChild(btn('Ubah', '', onEdit));
    a.appendChild(btn('Hapus', 'bhs', function () { if (window.confirm('Hapus "' + judul + '"?')) onDel(); }));
    r.appendChild(t); r.appendChild(a); return r;
  }

  function vPg() {
    var e = edit || { jenis: 'PR', judul: '', mapel: '', isi: '', tenggat: '' };
    var box = h('div', 'pn-box');
    box.appendChild(h('b', '', e.id ? 'Ubah item' : 'Tambah PR / ulangan / info'));
    var jenis = sel([['PR', 'PR'], ['Ulangan', 'Ulangan'], ['Info', 'Info']], e.jenis);
    var tg = inp('date', e.tenggat);
    var row = h('div', 'pn-row'); row.appendChild(fld('Jenis', jenis)); row.appendChild(fld('Tenggat / tanggal', tg));
    var judul = inp('text', e.judul, 120);
    var mp = inp('text', e.mapel, 40); mp.setAttribute('list', 'pn-mp');
    var dl = h('datalist'); dl.id = 'pn-mp';
    Object.keys(D.mapel).forEach(function (k) { if (k !== 'ISTIRAHAT' && k !== 'KOK') { var o = h('option'); o.value = D.mapel[k].nama; dl.appendChild(o); } });
    var isi = h('textarea'); isi.value = e.isi; isi.maxLength = 500;
    [row, fld('Judul', judul), fld('Mata pelajaran (opsional)', mp), dl, fld('Keterangan (opsional)', isi)].forEach(function (x) { box.appendChild(x); });
    var a = h('div', 'pn-act');
    a.appendChild(btn('Simpan', 'pri', function () {
      api('pg', { id: e.id, jenis: jenis.value, judul: judul.value, mapel: mp.value, isi: isi.value, tenggat: tg.value }).then(function () { edit = null; draw(); }).catch(function () {});
    }));
    if (e.id) a.appendChild(btn('Batal', '', function () { edit = null; draw(); }));
    box.appendChild(a); body.appendChild(box);

    var l = h('div', 'pn-box');
    if (!D.pengumuman.length) l.appendChild(h('small', '', 'Belum ada item.'));
    D.pengumuman.forEach(function (p) {
      l.appendChild(item('[' + p.jenis + '] ' + p.judul, (p.mapel ? p.mapel + ' · ' : '') + (p.tenggat || 'tanpa tanggal'),
        function () { edit = p; draw(); window.scrollTo(0, 0); body.scrollTop = 0; },
        function () { api('pgDel', { id: p.id }).catch(function () {}); }));
    });
    body.appendChild(l);
  }

  function lokal(ms) {
    var d = new Date(ms + 7 * 3600000); return d.toISOString().slice(0, 16);
  }
  function vCd() {
    var e = edit || { label: '', waktu: '' };
    var box = h('div', 'pn-box');
    box.appendChild(h('b', '', e.id ? 'Ubah countdown' : 'Tambah countdown'));
    var lb = inp('text', e.label, 80);
    var wk = inp('datetime-local', e.waktu ? lokal(e.waktu) : '');
    box.appendChild(fld('Nama acara (mis. Ulangan Matematika)', lb));
    box.appendChild(fld('Tanggal & jam (WIB)', wk));
    var a = h('div', 'pn-act');
    a.appendChild(btn('Simpan', 'pri', function () {
      api('cd', { id: e.id, label: lb.value, waktu: wk.value }).then(function () { edit = null; draw(); }).catch(function () {});
    }));
    if (e.id) a.appendChild(btn('Batal', '', function () { edit = null; draw(); }));
    box.appendChild(a); body.appendChild(box);
    var l = h('div', 'pn-box');
    if (!D.countdown.length) l.appendChild(h('small', '', 'Belum ada countdown. Maksimal 4 yang terdekat tampil di web.'));
    D.countdown.forEach(function (c) {
      l.appendChild(item(c.label, lokal(c.waktu).replace('T', ' ') + ' WIB' + (c.waktu < Date.now() ? ' (sudah lewat)' : ''),
        function () { edit = c; draw(); },
        function () { api('cdDel', { id: c.id }).catch(function () {}); }));
    });
    body.appendChild(l);
  }

  function vJd() {
    var chips = h('div', 'pn-tabs'); chips.style.padding = '0 0 12px'; chips.style.border = '0'; chips.style.background = 'none';
    HARI.forEach(function (x) { chips.appendChild(btn(x, x === hari ? 'on' : '', function () { hari = x; draw(); })); });
    body.appendChild(chips);
    var rows = JSON.parse(JSON.stringify(D.jadwal[hari] || []));
    var box = h('div', 'pn-box'), opts = Object.keys(D.mapel).map(function (k) { return [k, D.mapel[k].nama]; });
    function gambar() {
      box.textContent = '';
      rows.forEach(function (r, i) {
        var g = h('div', 'pn-jd');
        var m = inp('time', r.mulai), s = inp('time', r.selesai), k = sel(opts, r.kode), gu = inp('text', r.guru, 70);
        gu.placeholder = 'Guru (opsional)'; gu.style.gridColumn = '1/4';
        m.oninput = function () { r.mulai = m.value; }; s.oninput = function () { r.selesai = s.value; };
        k.onchange = function () { r.kode = k.value; }; gu.oninput = function () { r.guru = gu.value; };
        g.appendChild(m); g.appendChild(s); g.appendChild(k); g.appendChild(gu);
        var x = btn('Hapus jam ke-' + (i + 1), 'bhs', function () { rows.splice(i, 1); gambar(); });
        x.style.gridColumn = '1/4'; g.appendChild(x);
        box.appendChild(g); box.appendChild(h('hr')).style.cssText = 'border:0;border-top:1px solid var(--border);margin:8px 0';
      });
      var a = h('div', 'pn-act');
      a.appendChild(btn('Tambah jam', '', function () { rows.push({ mulai: '07:00', selesai: '08:00', kode: opts[0][0], guru: '' }); gambar(); }));
      a.appendChild(btn('Simpan ' + hari, 'pri', function () { api('jadwal', { hari: hari, rows: rows }).catch(function () {}); }));
      box.appendChild(a);
    }
    gambar(); body.appendChild(box);
  }

  function vPk() {
    var box = h('div', 'pn-box'), ta = {};
    box.appendChild(h('small', '', 'Satu nama per baris.'));
    HARI.forEach(function (x) { var t = h('textarea'); t.value = (D.piket[x] || []).join('\n'); ta[x] = t; box.appendChild(fld(x, t)); });
    box.appendChild(btn('Simpan semua piket', 'pri', function () {
      var data = {}; HARI.forEach(function (x) { data[x] = ta[x].value.split('\n'); });
      api('piket', { data: data }).catch(function () {});
    }));
    body.appendChild(box);
  }

  function vAk() {
    var b1 = h('div', 'pn-box'); b1.appendChild(h('b', '', 'Wali kelas'));
    var w = inp('text', D.waliKelas, 80); b1.appendChild(fld('Nama', w));
    b1.appendChild(btn('Simpan', 'pri', function () { api('info', { waliKelas: w.value }).catch(function () {}); }));
    var b2 = h('div', 'pn-box'); b2.appendChild(h('b', '', 'Ganti kata sandi'));
    var lm = inp('password'), br = inp('password'); lm.autocomplete = br.autocomplete = 'off';
    b2.appendChild(fld('Kata sandi lama', lm)); b2.appendChild(fld('Kata sandi baru (min. 12 karakter)', br));
    b2.appendChild(btn('Ganti', 'pri', function () { api('pass', { lama: lm.value, baru: br.value }).then(function () { lm.value = br.value = ''; }).catch(function () {}); }));
    var b3 = h('div', 'pn-box');
    b3.appendChild(btn('Keluar dari panel', '', function () {
      fetch('/api/a/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + window.__tok }, body: '{}' }).catch(function () {});
      try { sessionStorage.removeItem('k8h_t'); } catch (e) {} window.__adm = null; window.__tok = null; tutup();
    }));
    body.appendChild(b1); body.appendChild(b2); body.appendChild(b3);
  }


  // ---------- Keamanan: IP diblokir, akun chat, catatan kejadian ----------
  var EV = {
    reg: 'Akun chat dibuat', reg_fail: 'Pendaftaran ditolak', leave: 'Akun chat dihapus', badword: 'Kata kasar',
    rate: 'Terlalu cepat', login_ok: 'Masuk panel', login_fail: 'Gagal masuk panel', login_lock: 'Login dikunci',
    bad_json: 'Data rusak', bad_type: 'Tipe data salah', bad_origin: 'Asal ditolak', too_large: 'Data terlalu besar',
    bad_path: 'Jalur berbahaya', probe: 'Pemindaian situs', bad_method: 'Metode aneh', bad_http: 'HTTP rusak',
    sse_cap: 'Koneksi berlebih', akun_ban: 'Akun diblokir mencoba kirim', autoban: 'Blokir otomatis', admin_op: 'Aksi pengelola'
  };
  var scIp = '';

  function ambilSec() {
    return fetch('/api/a/sec' + (scIp ? '?ip=' + encodeURIComponent(scIp) : ''), { headers: { Authorization: 'Bearer ' + window.__tok }, cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('Gagal memuat data keamanan.'); return r.json(); });
  }
  function waktu(ms) { return lokal(ms).replace('T', ' ').slice(5); }

  function baris(judul, sub, tombol) {
    var r = h('div', 'pn-it'), t = h('div');
    t.appendChild(h('b', '', judul)); t.appendChild(h('small', '', sub));
    var a = h('div', 'pn-act');
    tombol.forEach(function (x) { a.appendChild(x); });
    r.appendChild(t); r.appendChild(a);
    return r;
  }
  function aksi(op, data) { return function () { api(op, data).catch(function () {}); }; }

  function vSc() {
    var ini = tab;
    body.appendChild(h('small', '', 'Memuat data keamanan...'));
    ambilSec().then(function (S) {
      if (tab !== ini || !body.isConnected) return;
      body.textContent = '';

      var f = h('div', 'pn-box');
      f.appendChild(h('b', '', 'Blokir IP'));
      f.appendChild(h('small', '', 'Satu IP bisa dipakai banyak orang (WiFi sekolah, paket data). Blokir hanya kalau jelas menyerang.'));
      var ipI = inp('text', '', 45); ipI.placeholder = 'Contoh: 203.0.113.7';
      var lama = sel([['1', '1 jam'], ['24', '24 jam'], ['168', '7 hari'], ['0', 'Permanen']], '24');
      var rw = h('div', 'pn-row'); rw.appendChild(fld('Alamat IP', ipI)); rw.appendChild(fld('Lama', lama));
      f.appendChild(rw);
      f.appendChild(btn('Blokir', 'pri', function () { api('ban', { ip: ipI.value.trim(), jam: Number(lama.value) }).catch(function () {}); }));
      body.appendChild(f);

      var b1 = h('div', 'pn-box'); b1.appendChild(h('b', '', 'IP diblokir (' + S.bans.length + ')'));
      if (!S.bans.length) b1.appendChild(h('small', '', 'Tidak ada.'));
      S.bans.forEach(function (x) {
        b1.appendChild(baris(x.ip, (x.permanen ? 'permanen' : 'sampai ' + waktu(x.sampai) + ' WIB') + (x.alasan ? ' · ' + x.alasan : ''),
          [btn('Buka blokir', '', aksi('unban', { ip: x.ip }))]));
      });
      body.appendChild(b1);

      var b2 = h('div', 'pn-box'); b2.appendChild(h('b', '', 'Akun chat (' + S.akun.length + ' terbaru)'));
      if (!S.akun.length) b2.appendChild(h('small', '', 'Belum ada akun.'));
      S.akun.forEach(function (x) {
        b2.appendChild(baris(x.nick + ' (#' + x.id + ')' + (x.banned ? ' · DIBLOKIR' : ''),
          'IP daftar ' + x.ip_first + ' · IP terakhir ' + x.ip_last + ' · ' + x.msgs + ' pesan · aktif ' + waktu(x.last_seen) + ' WIB',
          [btn(x.banned ? 'Buka akun' : 'Blokir akun', x.banned ? '' : 'bhs', aksi('akunBan', { id: x.id, ban: x.banned ? 0 : 1 })),
           btn('Lihat IP', '', function () { scIp = x.ip_last; draw(); })]));
      });
      body.appendChild(b2);

      var b3 = h('div', 'pn-box'); b3.appendChild(h('b', '', scIp ? 'Catatan kejadian untuk ' + scIp : 'Catatan kejadian terbaru'));
      var cari = inp('text', scIp, 45); cari.placeholder = 'Saring per IP (kosongkan untuk semua)';
      b3.appendChild(fld('IP', cari));
      var ba = h('div', 'pn-act');
      ba.appendChild(btn('Tampilkan', 'pri', function () { scIp = cari.value.trim(); draw(); }));
      if (scIp) ba.appendChild(btn('Semua IP', '', function () { scIp = ''; draw(); }));
      b3.appendChild(ba);
      if (!S.log.length) b3.appendChild(h('small', '', 'Belum ada kejadian.'));
      S.log.forEach(function (x) {
        var tb = [btn('IP ini', '', function () { scIp = x.ip; draw(); })];
        b3.appendChild(baris(waktu(x.t) + ' · ' + (EV[x.ev] || x.ev), x.ip + (x.detail ? ' · ' + x.detail : ''), tb));
      });
      body.appendChild(b3);
    }).catch(function (e) {
      if (tab !== ini) return;
      body.textContent = '';
      body.appendChild(h('small', '', e.message || 'Gagal memuat.'));
    });
  }

  function buka() {
    if (root && root.isConnected) return;
    root = h('div', 'pn'); root.setAttribute('role', 'dialog');
    var top = h('div', 'pn-top'); top.appendChild(h('b', '', 'Pengelola'));
    top.appendChild(btn('Tutup', '', tutup)); root.appendChild(top);
    var tabs = h('div', 'pn-tabs');
    [['pg', 'Tugas & info'], ['cd', 'Countdown'], ['jd', 'Jadwal'], ['pk', 'Piket'], ['sc', 'Keamanan'], ['ak', 'Akun']].forEach(function (t) {
      var b = btn(t[1], '', function () { tab = t[0]; edit = null; draw(); }); b.dataset.t = t[0]; tabs.appendChild(b);
    });
    root.appendChild(tabs);
    body = h('div', 'pn-body'); root.appendChild(body);
    document.body.appendChild(root);
    muat().catch(function () { toast('Gagal memuat data.', true); });
  }
  window.__adm = buka;
  buka();
})();
