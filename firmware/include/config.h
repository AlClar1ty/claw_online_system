#pragma once

// Isi nilai di bawah sebelum flash. Jangan menaruh Server Key Midtrans di sini.

#define WIFI_SSID "nama-wifi"
#define WIFI_PASSWORD "kata-sandi-wifi"

// Alamat komputer yang menjalankan server, di jaringan yang sama.
// Jangan pakai localhost: ESP32 tidak bisa menjangkau localhost komputer lain.
#define SERVER_URL "http://192.168.1.34:9000"

// Harus sama dengan DEVICE_TOKEN di environment server.
#define DEVICE_TOKEN "f9522c1ac66a95aaee0d004e21e8ee1548af625630558063"

// Kumparan relay Songle pada papan ESP32 1 kanal dengan terminal L/N
// (keluarga ESP32 Relay AC X1) sudah tersambung ke GPIO16.
// HIGH menutup kontak COM-NO.
#define RELAY_GPIO 16
#define RELAY_ACTIVE_HIGH 1

// Lama kontak tertutup, lalu jeda sebelum main berikutnya.
#define RELAY_ON_MS 80
#define RELAY_GAP_MS 200

#define WIFI_RETRY_MS 10000
#define POLL_INTERVAL_MS 2000
#define COMPLETE_RETRY_MS 3000
#define HTTP_TIMEOUT_MS 4000
