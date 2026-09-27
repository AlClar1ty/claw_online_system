# Pembayaran QRIS mesin capit

Sistem ini punya tiga bagian dalam satu repo:

- `server` menyimpan admin, token, pembayaran, dan antrean sinyal
- halaman web untuk pembeli dan admin, dilayani oleh server yang sama
- `firmware` untuk ESP32-WROOM-32 yang sudah menempel di papan relay

Pembeli memilih jumlah main, membayar QRIS, dan setelah status Midtrans `settlement` server mengantrekan sinyal ke mesin. ESP32 menutup kontak relay sekali untuk setiap main. Server Key Midtrans hanya ada di environment server.

## Papan dan GPIO

Papan yang dipakai sudah berisi ESP32-WROOM-32 dan satu relay Songle SRD-05VDC-SL-C. Tidak perlu modul relay tambahan.

Pada papan ESP32 satu kanal dengan terminal sekrup L/N (keluarga **ESP32 Relay AC X1** dan klon dengan tata letak yang sama), jalur kumparan relay sudah ke **GPIO16**. Level **HIGH** menutup kontak COM–NO. Firmware memakai pin itu. LED onboard di GPIO23 dan tombol di GPIO0 tidak dipakai.

Daya papan dari **USB 5 V**. Terminal **L** dan **N** adalah masukan PLN pada papan ini. Jangan dihubungkan ke listrik PLN dan jangan dipakai untuk sinyal koin.

## Sambungan COM dan NO

Kontak yang dipakai hanya kontak kering relay. Dua kawat sinyal koin mesin diparalel ke **COM** dan **NO**. Urutan kedua kawat tidak masalah, karena kontak ini tidak punya polaritas dan papan tidak mengirim tegangan ke mesin. **NC** dibiarkan kosong. Saat kumparan mati, COM di dalam relay terhubung ke NC, tetapi terminal NC tidak disambung jadi tidak ada efek.

```
                         USB 5 V
                            |
                            v
              +----------------------------------+
              |  ESP32-WROOM-32                  |
              |  kumparan relay -> GPIO16        |
              |  Relay Songle SRD-05VDC-SL-C     |
              |                                  |
              |  NC      COM      NO    |  L   N |
              +----------------------------------+
                 |       |        |         |   |
                (kosong) |        |      (jangan disambung
                         |        |       ke PLN)
                         +---+----+
                             |
                    dua kawat sinyal koin
                    (kontak kering, paralel)
```

Saat satu main dikirim, GPIO16 HIGH sekitar 80 ms sehingga COM dan NO terhubung, lalu LOW, lalu jeda sekitar 200 ms sebelum main berikutnya. Kedua waktu ada di `firmware/include/config.h`.

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
| `DEVICE_TOKEN` | String acak. Nilai yang sama ditulis di firmware. |
| `ADMIN_USERNAME` | Username admin pertama. |
| `ADMIN_PASSWORD` | Kata sandi admin pertama, minimal 8 karakter. Dipakai hanya saat database masih kosong. |
| `PAYMENT_EXPIRY_MINUTES` | Masa berlaku QR, 1 sampai 60. |
| `MIDTRANS_NOTIFICATION_URL` | Opsional. URL publik webhook, lihat di bawah. |

Buat dua string acak:

```powershell
node --input-type=module -e "import crypto from 'node:crypto'; console.log(crypto.randomBytes(24).toString('hex'))"
```

Jalankan perintah itu dua kali, sekali untuk `JWT_SECRET` dan sekali untuk `DEVICE_TOKEN`.

Admin pertama bisa masuk setelah server dijalankan. Dari situ admin menambah akun lain, mengubahnya, atau menonaktifkannya, lalu mengatur harga dan jumlah main tiap token. Token yang dinonaktifkan tidak muncul di halaman pembeli. Harga pembayaran diambil dari data token di server, bukan dari halaman web.

## Uji sandbox Midtrans

1. Isi `MIDTRANS_SERVER_KEY` dengan Server Key **sandbox**, dan biarkan `MIDTRANS_IS_PRODUCTION=false`.
2. Jalankan server, masuk sebagai admin, lalu buat token (harga dan jumlah main).
3. Buka halaman pembeli, pilih token. QRIS dan status muncul.
4. Di kotak sandbox pada halaman itu ada URL gambar QR. Buka [simulator QRIS Midtrans](https://simulator.sandbox.midtrans.com/qris/index), tempel URL itu, lalu selesaikan pembayaran. Akun yang masih memakai alur SNAP dapat memakai [simulator QRIS OpenAPI](https://simulator.sandbox.midtrans.com/openapi/qris/index).
5. Jangan memindai QR sandbox dengan dompet yang dipakai sehari-hari. Midtrans menandai bahwa pembayaran QRIS sungguhan pada QR uji bisa masuk ke akun produksi.
6. Halaman pembeli menanyakan status ke server setiap dua detik. Server lalu membaca status di Midtrans. Saat statusnya `settlement` dan `fraud_status` bernilai `accept`, sinyal diantrekan. Halaman menampilkan pembayaran berhasil.
7. Jika pembayaran gagal atau kedaluwarsa, halaman menampilkan status itu dan tombol kembali ke daftar token.

Webhook tetap tersedia di `POST /api/midtrans/notification`. Untuk komputer di rumah, teruskan HTTPS publik ke port server (misalnya dengan tunnel) dan isi URL itu di dashboard Midtrans atau di `MIDTRANS_NOTIFICATION_URL`. Tanpa webhook, langkah 6 tetap cukup untuk uji lokal karena halaman pembeli memicu pengecekan status.

Sinyal tidak dikirim untuk status `pending`, `expire`, `deny`, `cancel`, atau `failure`. Notifikasi yang sama, atau notifikasi plus pengecekan status, tidak menambah antrean kedua. Nominal yang tidak sama dengan harga token juga tidak mengantrekan sinyal.

## Flash ESP32

Pasang [PlatformIO](https://platformio.org/install/cli) atau ekstensi PlatformIO di editor. Edit `firmware/include/config.h`:

- `WIFI_SSID` dan `WIFI_PASSWORD`
- `SERVER_URL` dengan IP komputer di jaringan yang sama, misalnya `http://192.168.1.10:3000`. Jangan memakai `localhost`.
- `DEVICE_TOKEN` persis sama dengan `DEVICE_TOKEN` di `.env`

IP komputer bisa dilihat dengan `ipconfig`, pada alamat IPv4 adaptor Wi-Fi. Izinkan port server di Windows Firewall agar ESP32 bisa menghubungi komputer.

Colokkan papan lewat USB. Dari folder `firmware`:

```powershell
cd firmware
pio run -t upload
pio device monitor
```

Jika upload tidak mulai, tahan tombol IO0 saat USB dihubungkan, lalu ulangi upload. Monitor serial menampilkan sisa pulsa dan status Wi-Fi. Keluar dari monitor dengan `Ctrl+C`.

Board PlatformIO yang dipakai adalah `esp32dev` (ESP32-WROOM-32). Firmware tidak memanggil API Midtrans.

## Sisa pulsa saat listrik atau Wi-Fi putus

ESP32 menyimpan nomor pembayaran dan sisa pulsa di memori NVS sebelum relay digerakkan. Setelah tiap main, sisa pulsa dikurangi dan ditulis lagi. Jika listrik putus di tengah antrean, setelah nyala ulang papan meneruskan sisa itu, bukan mengulang dari nol. Wi-Fi yang putus tidak menghentikan pulsa yang sudah tersimpan. Laporan selesai dikirim setelah semua pulsa lokal habis dan Wi-Fi kembali.

Satu pembayaran hanya diambil satu kali untuk dijalankan. Jika responsnya hilang sebelum ESP32 sempat menyimpan, papan yang sama akan menerima pekerjaan itu lagi. Papan lain tidak bisa mengambil pekerjaan yang sudah dipegang. Setelah sisa pulsa tersimpan di NVS, papan tidak meminta antrean baru sampai laporan selesai terkirim, jadi pulsa yang sudah berjalan tidak diulang dari nol.
