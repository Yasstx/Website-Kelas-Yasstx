# Web Kelas 

Website kelas berbasis **Node.js + MySQL** untuk jadwal, tugas/ulangan, countdown,
piket, struktur kelas, kenangan, media sosial, dan chat berakun. Data kelas disimpan
di database; foto dan musik berada di folder 

https://viii-heavenly.duckdns.org

## Fitur utama

- Jadwal pelajaran dan pelajaran yang sedang berlangsung.
- Tugas, informasi kelas, countdown, dan piket.
- Struktur kelas, tautan media sosial, foto kenangan, dan musik.
- Chat dengan nickname unik dan token akun.
- Panel pengelola tersembunyi dengan pengaturan konten dan keamanan.
- Pembatasan laju, pencatatan kejadian, filter kata kasar, dan blokir IP.

## Struktur penting

```text
kemaan.js      server HTTP utama
index.js       pengait agar server juga bisa dijalankan dengan index.js
db.js          koneksi MySQL dan akses data kelas
chat.js        API chat berakun (SSE)
panel.js       API panel pengelola
panel-ui.js    tampilan panel setelah login
guard.js       batas laju, pencatatan, dan blokir IP
filter.js      filter kata kasar
env.js         pembaca konfigurasi .env
badwords.json  daftar kata yang difilter
seed.json      data awal saat tabel masih kosong
public/        halaman, logo, foto, dan musik
.env.example   contoh konfigurasi; salin menjadi .env di server
KEAMANAN.md    catatan keamanan dan pemeriksaan lanjutan
```

## Kebutuhan

- Node.js 20 LTS atau lebih baru.
- MySQL 8 atau MariaDB yang bisa diakses server.
- Panel hosting Node.js, misalnya Pterodactyl.


## Menjalankan di Pterodactyl

1. Upload **isi** folder proyek ke `/home/container`, lalu timpa versi lama jika
   ini pembaruan.
2. Salin `.env.example` menjadi `.env` melalui File Manager Pterodactyl, kemudian
   isi `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, dan `DB_NAME`.
3. Pastikan `.env` tidak pernah di-commit atau dikirim ke orang lain.
4. Gunakan image Node.js 20 atau lebih baru. Jalankan `npm install` jika egg tidak
   menjalankannya otomatis.
5. Perintah start: `node kemaan.js` (atau `npm start`).
6. Saat pertama hidup, tabel database dibuat otomatis dan data dari `seed.json`
   dipakai jika tabel masih kosong.
7. Cek `https://alamat-situs/healthz`. Respons berhasil menandakan server hidup.

Jika situs berada di balik reverse proxy atau Cloudflare, sesuaikan `TRUST_PROXY`
di `.env`. Password panel bisa diatur lewat `ADMIN_PASS` dengan minimal 12 karakter;
jika dikosongkan, server membuat password acak dan mencetaknya sekali di console.

## Pengelolaan situs

- Buka panel dengan mengetuk logo sekolah lima kali cepat, lalu masukkan password.
- Foto (jpg, png, webp, gif) diletakkan di `public/foto`.
- Musik kenangan diganti melalui `public/musik/kenangan.mp3`.
- Daftar filter diperbarui di `badwords.json`, lalu server di-restart.
- Struktur kelas dan media sosial tersimpan sebagai JSON di tabel `kelas_data`.
- Riwayat chat dapat dikosongkan dari phpMyAdmin dengan `DELETE FROM chat_messages;`.
- Baca `KEAMANAN.md` sebelum membuka situs untuk umum.

## Pemecahan masalah

- **Server langsung berhenti:** periksa nilai `.env`, terutama koneksi MySQL.
- **`npm install` gagal:** gunakan Node.js 20 LTS dan jalankan kembali dengan
  `npm install`.
- **Foto tidak muncul:** cek nama file, ekstensi, dan folder `public/foto`.
- **Chat tidak tersambung:** pastikan HTTPS/proxy meneruskan koneksi SSE dan
  server dapat mengakses database.
- **Perubahan teman belum terlihat:** buka cabang `main` dan tarik perubahan
  setelah pull request selesai digabung.

## Lisensi

Gunakan dan ubah proyek ini sesuai kebutuhan kelas. Pastikan izin semua orang
yang fotonya atau datanya ditampilkan sudah diperoleh.
