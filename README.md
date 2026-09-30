# Pembayaran QRIS mesin capit

Sistem ini berjalan di satu Raspberry Pi:

- `server` menyimpan admin, token, pembayaran, dan antrean sinyal
- halaman web untuk pembeli dan admin, dilayani oleh server yang sama
- GPIO Raspberry Pi menutup kontak relay sekali untuk setiap main

Pembeli memilih jumlah main, membayar QRIS, dan setelah status Midtrans `settlement` server mengantrekan sinyal. Proses yang sama lalu menggerakkan GPIO. Server Key Midtrans hanya ada di environment server. Folder `firmware` adalah pengirim sinyal ESP32 yang tidak dipakai lagi.

## Memasang relay di Raspberry Pi

Modul yang dipakai adalah relay Songle 2 kanal, kumparan 5 V. Gambar sambungannya ada di [docs/sambungan-relay.svg](docs/sambungan-relay.svg). Matikan Pi dan cabut daya sebelum memasang kabel. GPIO tidak boleh disambung langsung ke dua kawat sinyal koin. Jangan sambung apa pun ke listrik PLN.

Hanya kanal 1 yang dipakai. Dari ujung header yang dekat slot microSD:

| Kawat | Pin Raspberry Pi | Kaki modul |
| --- | --- | --- |
| Merah | Pin 2, 5 V, di tepi luar | VCC |
| Hitam | Pin 6, GND, di tepi luar | GND |
| Hijau | Pin 11, BCM 17, di sisi dalam | IN1 |

IN2 tidak disambung. Jumper RY-VCC ke VCC dibiarkan terpasang. Pin 1 (3,3 V) tidak dipakai.

Pada sekrup kanal 1, COM dan NO pergi ke dua kawat sinyal koin. Urutan kedua kawat bebas. NC kosong. Sekrup tengah pada terminal ini biasanya COM; cocokkan dengan cetakan di papan. Kanal 2 tidak dipakai.

Modul ini menutup COM–NO saat IN1 berlevel LOW, sekitar 80 ms, lalu jeda sekitar 200 ms. Saat tidak ada main, pin 11 berlevel HIGH dan kontak lepas. Kedua waktu, dan tombol kirim sinyal uji, ada di menu Relay pada halaman admin. Nilai awal waktunya `RELAY_ON_MS` dan `RELAY_GAP_MS`. Di environment, `RELAY_ACTIVE_HIGH=false`.

Sisa pulsa ditulis ke `server/data/relay-state.json` sebelum relay bergerak. Jika listrik putus di tengah antrean, setelah nyala ulang Pi meneruskan sisa itu. Satu pembayaran hanya diambil satu kali. Permintaan HTTP ke `/api/machine/jobs` ditolak supaya perangkat lain tidak mengirim sinyal yang sama.

## Menjalankan server

Perlu Node.js 22.13 atau lebih baru. Perintah di bawah untuk PowerShell.

```powershell
cd server
Copy-Item .env.example .env
npm install
npm test
npm start
```

Buka `http://localhost:3000` untuk pembeli dan `http://localhost:3000/admin` untuk admin.

`npm test` memeriksa login admin, token aktif, tanda tangan webhook, serta aturan bahwa satu pembayaran mengantrekan sinyal satu kali.

## Mengisi environment

Edit `server/.env`. Arti tiap nilai ada di `server/.env.example`.

| Nama | Isi |
| --- | --- |
| `MIDTRANS_SERVER_KEY` | Server Key sandbox dari dashboard Midtrans, menu Settings, Access Keys. Kunci sandbox diawali `SB-Mid-server`. |
| `MIDTRANS_IS_PRODUCTION` | `false` untuk sandbox. |
| `MIDTRANS_QRIS_ACQUIRER` | `gopay` atau `airpay shopee`. |
| `JWT_SECRET` | String acak, minimal 24 karakter. |
| `DEVICE_TOKEN` | String acak. Tidak menggerakkan GPIO saat `LOCAL_RELAY=true`. |
| `LOCAL_RELAY` | `true` agar GPIO Raspberry yang mengirim sinyal. |
| `RELAY_GPIO` | Nomor BCM, `17` untuk pin fisik 11. |
| `RELAY_ACTIVE_HIGH` | `false` untuk modul Songle 2 kanal ini. Kontak menutup saat pin LOW. |
| `RELAY_ON_MS` | Lama kontak tertutup, bawaan `80`. |
| `RELAY_GAP_MS` | Jeda antar main, bawaan `200`. |
| `ADMIN_USERNAME` | Username admin pertama. |
| `ADMIN_PASSWORD` | Kata sandi admin pertama, minimal 8 karakter. Dipakai hanya saat database masih kosong. |
| `PAYMENT_EXPIRY_MINUTES` | Masa berlaku QR, 1 sampai 60. |
| `MIDTRANS_NOTIFICATION_URL` | Opsional. URL publik webhook, lihat di bawah. |

Buat dua string acak:

```powershell
node --input-type=module -e "import crypto from 'node:crypto'; console.log(crypto.randomBytes(24).toString('hex'))"
```

Jalankan perintah itu dua kali, sekali untuk `JWT_SECRET` dan sekali untuk `DEVICE_TOKEN`.

Admin pertama bisa masuk setelah server dijalankan. Dari situ admin menambah akun lain, mengubahnya, atau menonaktifkannya, lalu mengatur harga dan jumlah main tiap token. Menu riwayat menampilkan setiap pembelian beserta status pembayaran dan status sinyal. Token yang dinonaktifkan tidak muncul di halaman pembeli. Harga pembayaran diambil dari data token di server, bukan dari halaman web.

## Uji sandbox Midtrans

1. Isi `MIDTRANS_SERVER_KEY` dengan Server Key **sandbox**, biarkan `MIDTRANS_IS_PRODUCTION=false`, dan untuk simulator pakai `MIDTRANS_QRIS_ACQUIRER=airpay shopee`. Acquirer `gopay` menaruh identitas toko pada akun Midtrans ke dalam QR, sehingga simulator sering menjawab error 116 merchant not found.
2. Jalankan server, masuk sebagai admin, lalu buat token (harga dan jumlah main).
3. Buka halaman pembeli, pilih token. QRIS dan status muncul.
4. Di kotak sandbox pada halaman itu ada URL gambar QR. Buka [simulator QRIS Midtrans](https://simulator.sandbox.midtrans.com/qris/index), tempel URL itu, lalu selesaikan pembayaran. Akun yang masih memakai alur SNAP dapat memakai [simulator QRIS OpenAPI](https://simulator.sandbox.midtrans.com/openapi/qris/index).
5. Jangan memindai QR sandbox dengan dompet yang dipakai sehari-hari. Midtrans menandai bahwa pembayaran QRIS sungguhan pada QR uji bisa masuk ke akun produksi.
6. Halaman pembeli menanyakan status ke server setiap dua detik. Server lalu membaca status di Midtrans. Saat statusnya `settlement` dan `fraud_status` bernilai `accept`, sinyal diantrekan. Halaman menampilkan pembayaran berhasil.
7. Jika pembayaran gagal atau kedaluwarsa, halaman menampilkan status itu dan tombol kembali ke daftar token.

Webhook tetap tersedia di `POST /api/midtrans/notification`. Untuk komputer di rumah, teruskan HTTPS publik ke port server (misalnya dengan tunnel) dan isi URL itu di dashboard Midtrans atau di `MIDTRANS_NOTIFICATION_URL`. Tanpa webhook, langkah 6 tetap cukup untuk uji lokal karena halaman pembeli memicu pengecekan status.

Sinyal tidak dikirim untuk status `pending`, `expire`, `deny`, `cancel`, atau `failure`. Notifikasi yang sama, atau notifikasi plus pengecekan status, tidak menambah antrean kedua. Nominal yang tidak sama dengan harga token juga tidak mengantrekan sinyal.
