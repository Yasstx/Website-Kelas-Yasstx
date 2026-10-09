# Keamanan Web Kelas VIII.H

## Jujur dulu: "celah 0%" tidak ada

Tidak ada website yang bisa dijamin 0% celah, dan siapa pun yang menjanjikan itu keliru. Yang bisa dilakukan:
menutup semua celah yang diketahui, memperkecil permukaan serangan, membatasi dampak kalau ada yang lolos,
dan mendeteksi pelakunya. Itu yang dikerjakan di sini. Sisanya (HTTPS, firewall, backup, pemantauan)
ada di bagian "Yang masih harus ditambahkan" dan tidak bisa diselesaikan dari dalam kode.

## Lakukan sekarang, urut

1. **Ganti password database.** Versi lama menaruh host, user, dan password database langsung di `db.js`,
   dan file itu ada di dalam zip. Anggap password lama sudah bocor ke semua orang yang pernah memegang zip.
   Ganti di panel Pterodactyl (tab Databases), lalu hapus zip lama dari tempat yang dibagikan.
2. **Buat `.env`** dari `.env.example` dan isi kredensial baru. Server menolak jalan tanpa itu.
3. **Isi `TRUST_PROXY`** sesuai cara situs diakses (lihat `.env.example`). Salah isi = IP pengunjung salah.
4. **Pasang HTTPS.** Tanpa HTTPS, sandi panel dan token chat terkirim tanpa enkripsi di WiFi mana pun.
5. **Beri tahu pengguna chat** bahwa mereka perlu membuat nickname lagi (sekali). Akun lama tidak punya token.
6. Buka situs di browser dan lihat Console (F12). Kalau ada pesan "Content Security Policy" yang memblokir
   sesuatu, kabari saya. CSP sudah diuji bentuknya, tetapi belum dijalankan di browser asli.

## Celah yang ditemukan dan perbaikannya

| Celah di versi lama | Perbaikan |
|---|---|
| Kredensial database tertanam di kode dan ikut di zip | Dipindah ke `.env`, tidak ada nilai bawaan, server berhenti kalau kosong |
| IP diambil dari header `X-Forwarded-For` yang bisa dipalsukan siapa saja: pembatas laju chat dan kunci login admin bisa dilewati, memori bisa dibanjiri IP palsu | IP diambil dari koneksi. Header proxy hanya dipercaya bila `TRUST_PROXY` diisi, itu pun entri paling kanan |
| Chat memercayai nickname dan `cid` dari browser: siapa pun bisa kirim pesan atas nama orang lain | Akun bertoken. Pesan hanya diterima dengan token rahasia, nickname unik, pesan memakai nickname milik akun |
| Nickname bisa meniru peran resmi ("Adm1n", "A d m i n") dan meniru teman ("Bud1") | Nickname dinormalisasi (spasi, `_`, angka pengganti huruf, huruf ganda) sebelum dicek unik dan dicadangkan |
| Kata kasar bisa disamarkan dengan karakter tak terlihat | Karakter tak terlihat dan bidi dibuang sebelum filter |
| Filter kata kasar dijalankan sebelum batas laju, jadi bisa dipakai membebani CPU | Batas laju dulu, baru filter |
| POST tidak mengecek tipe atau asal: situs lain bisa menyuruh browser korban mengirim pesan (CSRF) | Wajib `application/json` dan cek `Origin` di semua POST |
| Tidak ada CSP dan header keamanan | CSP berbasis nonce tanpa `unsafe-inline`/`unsafe-eval`, `X-Frame-Options`, COOP, CORP, Permissions-Policy, HSTS bila HTTPS |
| Panel: logout hanya menghapus token di browser, token tetap hidup 12 jam | Logout menghapus sesi di server, masa sesi 2 jam, token disimpan sebagai hash |
| Panel: ganti sandi tidak mengeluarkan sesi lain, sandi minimal 6 | Sesi lain keluar otomatis, minimal 12 karakter, sandi awal acak 16 karakter |
| Panel: hash sandi dihitung sinkron, menghentikan seluruh server selama perhitungan | `scrypt` asinkron (parameter sama, sandi lama tetap berlaku) |
| Panel: gagal login tanpa jeda | Jeda 0,6 dtk tiap gagal, kunci per IP (5x) dan global (30x) per 10 menit |
| Panel: ID tidak divalidasi, kode mapel `constructor`/`__proto__` lolos pengecekan, pesan error internal dikirim ke klien | ID harus bilangan bulat positif, cek `hasOwnProperty`, pesan error generik kecuali pesan validasi |
| Tidak ada batas permintaan keseluruhan, koneksi SSE tanpa batas, tidak ada timeout (slowloris), file besar dibaca penuh ke memori | Batas 600 permintaan/menit/IP, SSE maks. 60/IP dan 600 total, timeout header/permintaan, file disajikan sebagai stream dengan ETag |
| File statis: tidak ada daftar ekstensi, tidak cek symlink | Hanya ekstensi yang dikenal, `realpath` harus di dalam `public/`, file tersembunyi ditolak |
| Pemindai (`/wp-login.php`, `/.env`, `/db.js`, dst.) tidak terdeteksi | Dicatat sebagai kejadian, skor naik, IP diblokir otomatis 30 menit di skor 20 |
| Database: tidak menyambung ulang kalau MySQL restart, antrean kueri tanpa batas, tidak ada TLS | Coba lagi otomatis, antrean dibatasi, `DB_SSL=1` tersedia |
| Foto berisi EXIF (merek/model HP, waktu) dan video tersembunyi di file Motion Photo yang bisa diambil siapa pun | Metadata dan video dibuang, ukuran 14,8 MB jadi 3,7 MB. Foto asli ada di zip yang kamu unggah ke saya |
| `BACA-SAYA.txt` (catatan pengembang) tersaji publik di `/foto/` | Dihapus |

## Kode yang dibuang

- 3.028 entri `badwords.json` yang tidak pernah dibaca (file 204 KB jadi 161 KB). Perilaku filter diuji identik pada 16.547 contoh kata.
- ID perangkat `cid` (diganti akun bertoken), cadangan chat di memori saat database mati, `pool.end()` ganda, alias variabel dan komentar kembar.
- `BACA-SAYA.txt`.

`index.js` sengaja dipertahankan: egg Pterodactyl biasanya menjalankan `index.js`.

## Cara kerja deteksi IP, dan batasnya

- IP tercatat saat **membuat akun**, saat **kirim pesan**, dan di setiap **kejadian mencurigakan**
  (tab Keamanan di panel). Akun menyimpan IP pertama dan IP terakhir.
- IP **bukan identitas**. Pelaku bisa memakai VPN, proxy, atau paket data lain, dan satu IP WiFi sekolah dipakai
  puluhan siswa. Memblokir IP sekolah berarti memblokir semua orang di sekolah itu. Pakai IP sebagai petunjuk
  bersama akun, waktu, dan isi pesan, jangan sebagai bukti tunggal.
- Pelaku yang ganti IP tetap harus membuat akun baru; pembuatan akun dibatasi 40 percobaan/jam/IP.
- **Data pribadi.** Siswa SMP adalah anak di bawah umur dan IP termasuk data pribadi (UU PDP No. 27/2022).
  Pengguna sudah diberi tahu di layar chat. Data IP dihapus otomatis setelah 30 hari (`LOG_DAYS`), akun tidak aktif
  setelah 90 hari (`ACCOUNT_DAYS`). Pastikan pihak sekolah/klien tahu dan setuju, dan simpan bukti serangan
  (tangkapan layar) sebelum masa simpan habis. Saya bukan penasihat hukum; konfirmasi ke pihak yang berwenang.

## Yang masih harus ditambahkan (di luar kode)

**Wajib**
1. HTTPS dengan sertifikat valid (Cloudflare gratis, atau nginx + Let's Encrypt), dan alihkan semua http ke https.
2. Password database baru, dan user database khusus aplikasi dengan hak minimal
   (`SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER` pada satu database saja, bukan akun utama).
3. Batasi siapa yang bisa menyambung ke port database (firewall hanya dari IP server web), dan aktifkan `DB_SSL=1`
   bila database tidak di mesin yang sama.
4. Backup database otomatis (misalnya `mysqldump` harian) disimpan di luar server, dan uji pemulihannya sekali.
5. Sandi panel unik dan panjang (pakai password manager). Kalau IP pengelola tetap, isi `ADMIN_ALLOW_IPS`.

**Sangat disarankan**
6. Cloudflare di depan situs: Bot Fight Mode, aturan rate limit untuk `/api/*`, dan tantangan (challenge) untuk
   `/api/a/login`. Serangan banjir besar (DDoS) tidak bisa dihentikan oleh aplikasi Node itu sendiri. Setelah aktif,
   isi `TRUST_PROXY=cloudflare` dan batasi server agar hanya menerima trafik dari rentang IP Cloudflare.
7. Pantau: UptimeRobot atau sejenisnya ke `/healthz`, dan lihat tab Keamanan secara berkala
   (banyak `login_fail`, `autoban`, `probe` berarti sedang diserang).
8. Pakai Node.js LTS terbaru, jalankan `npm audit` tiap bulan, dan perbarui `mysql2`.
9. Pindai situs setelah dipasang: <https://securityheaders.com>, <https://observatory.mozilla.org>,
   dan OWASP ZAP (baseline scan). Ulangi setiap ada perubahan besar.
10. Pasang Google Fonts di server sendiri (unduh file font ke `public/`), lalu ketatkan CSP jadi `style-src` dan
    `font-src` hanya `'self'`. Sekarang setiap pengunjung mengirim IP-nya ke Google.
11. Kebijakan privasi singkat di situs dan izin dari sekolah/orang tua untuk foto dan nama siswa.
    Pertimbangkan hanya nama panggilan di struktur kelas dan jadwal piket, karena `/api/data` terbuka untuk umum.

**Pengembangan lanjutan**
12. Login panel dengan 2FA (TOTP).
13. CAPTCHA (misalnya Cloudflare Turnstile) saat membuat akun chat.
14. Fitur hapus pesan dan laporan pesan untuk moderasi.
15. Aturan CSP `report-uri` untuk melihat pelanggaran di lapangan.

## Kalau ada serangan

1. Buka panel, tab **Keamanan**, saring per IP, tangkap layar buktinya.
2. Blokir akun, lalu IP kalau perlu (ingat risiko IP bersama).
3. Ganti sandi panel (sesi lain otomatis keluar) dan password database.
4. Cek `console` Pterodactyl untuk pesan `[error]`, `[autoban]`, atau lonjakan 429.

## Hasil pengujian

Diuji di MariaDB 10.11 dan Node.js 22: pengujian otomatis sisi server (akses file, traversal, CSRF, akun dan peniruan nickname,
IP palsu, login/sesi panel, blokir manual dan otomatis, batas laju, SSE, retensi data) serta uji asap di jsdom
(daftar chat, kirim pesan, panel, tab Keamanan). **Belum diuji:** browser asli (penegakan CSP), MySQL 8, Pterodactyl,
dan Cloudflare. Lakukan uji langsung di server sebelum diserahkan ke klien.
