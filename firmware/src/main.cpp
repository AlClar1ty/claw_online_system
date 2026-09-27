#include <Arduino.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <ArduinoJson.h>

#include "config.h"

static const uint8_t RELAY_LEVEL_ON = RELAY_ACTIVE_HIGH ? HIGH : LOW;
static const uint8_t RELAY_LEVEL_OFF = RELAY_ACTIVE_HIGH ? LOW : HIGH;
static const char *NVS_NAMESPACE = "claw";
static const char *NVS_PAYMENT = "pay";
static const char *NVS_REMAIN = "rem";

Preferences prefs;
String serverBase;
uint32_t payId = 0;
uint32_t remain = 0;
uint32_t phaseAt = 0;
uint32_t nextNetAt = 0;
uint32_t lastWifiTry = 0;
bool wifiAnnounced = false;

enum Phase { PHASE_IDLE, PHASE_ON, PHASE_GAP };
Phase phase = PHASE_IDLE;

void relayOff() {
  digitalWrite(RELAY_GPIO, RELAY_LEVEL_OFF);
}

void clearJob();

void loadPulseState() {
  prefs.begin(NVS_NAMESPACE, false);
  payId = prefs.getUInt(NVS_PAYMENT, 0);
  remain = prefs.getUInt(NVS_REMAIN, 0);
  if (remain > 100) {
    Serial.println("Sisa pulsa tersimpan tidak valid");
    clearJob();
  }
}

void rememberJob(uint32_t id, uint32_t pulses) {
  prefs.putUInt(NVS_PAYMENT, id);
  prefs.putUInt(NVS_REMAIN, pulses);
  payId = prefs.getUInt(NVS_PAYMENT, 0);
  remain = prefs.getUInt(NVS_REMAIN, 0);
}

void clearJob() {
  prefs.putUInt(NVS_REMAIN, 0);
  prefs.putUInt(NVS_PAYMENT, 0);
  payId = 0;
  remain = 0;
}

String trimSlash(String url) {
  while (url.endsWith("/")) url.remove(url.length() - 1);
  return url;
}

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiAnnounced) {
      wifiAnnounced = true;
      Serial.print("Wi-Fi tersambung ");
      Serial.println(WiFi.localIP());
    }
    return;
  }
  wifiAnnounced = false;
  if (millis() - lastWifiTry < WIFI_RETRY_MS) return;
  lastWifiTry = millis();
  Serial.println("Menyambungkan Wi-Fi...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void serviceRelay() {
  if (phase == PHASE_ON) {
    if (millis() - phaseAt < RELAY_ON_MS) return;
    relayOff();
    if (remain > 0) remain--;
    prefs.putUInt(NVS_REMAIN, remain);
    Serial.printf("Pulsa selesai, sisa %u\n", remain);
    if (remain == 0) {
      phase = PHASE_IDLE;
    } else {
      phase = PHASE_GAP;
      phaseAt = millis();
    }
    return;
  }

  if (phase == PHASE_GAP) {
    if (millis() - phaseAt < RELAY_GAP_MS) return;
    phase = PHASE_IDLE;
  }

  if (phase == PHASE_IDLE && remain > 0) {
    digitalWrite(RELAY_GPIO, RELAY_LEVEL_ON);
    phase = PHASE_ON;
    phaseAt = millis();
    Serial.printf("Kontak COM-NO tertutup, sisa %u\n", remain);
  }
}

bool relayBusy() {
  return phase != PHASE_IDLE || remain > 0;
}

void pollJob() {
  if (payId != 0 || remain != 0) return;
  WiFiClient client;
  HTTPClient http;
  const String url = serverBase + "/api/machine/jobs";
  if (!http.begin(client, url)) return;
  http.addHeader("X-Device-Token", DEVICE_TOKEN);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  const int code = http.GET();
  const String body = http.getString();
  http.end();
  if (code != 200) {
    Serial.printf("Antrean ditolak, HTTP %d\n", code);
    return;
  }

  JsonDocument doc;
  if (deserializeJson(doc, body)) {
    Serial.println("Respons antrean tidak valid");
    return;
  }
  if (doc["job"].isNull()) return;

  const uint32_t id = doc["job"]["payment_id"] | 0;
  const uint32_t pulses = doc["job"]["pulses"] | 0;
  if (id == 0 || pulses == 0 || pulses > 100) {
    Serial.println("Antrean diabaikan");
    return;
  }

  // Simpan dulu. Jika listrik putus setelah baris ini, sisa pulsa dilanjutkan,
  // tidak diminta ulang dari server.
  rememberJob(id, pulses);
  Serial.printf("Antrean %u disimpan, %u pulsa\n", payId, remain);
}

void reportDone() {
  if (payId == 0 || remain != 0) return;
  WiFiClient client;
  HTTPClient http;
  const String url = serverBase + "/api/machine/jobs/" + String(payId) + "/complete";
  if (!http.begin(client, url)) return;
  http.addHeader("X-Device-Token", DEVICE_TOKEN);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  const int code = http.POST("{}");
  http.end();
  if (code == 200 || code == 404) {
    if (code == 404) Serial.println("Server tidak lagi menyimpan antrean ini");
    clearJob();
    Serial.println("Laporan selesai terkirim");
    return;
  }
  Serial.printf("Laporan selesai gagal, HTTP %d\n", code);
}

void serviceServer() {
  if (relayBusy()) return;
  if (millis() < nextNetAt) return;
  if (WiFi.status() != WL_CONNECTED) return;
  if (payId != 0) {
    nextNetAt = millis() + COMPLETE_RETRY_MS;
    reportDone();
    return;
  }
  nextNetAt = millis() + POLL_INTERVAL_MS;
  pollJob();
}

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_GPIO, OUTPUT);
  relayOff();
  serverBase = trimSlash(SERVER_URL);
  loadPulseState();
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setHostname("claw-machine");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("GPIO relay %d, sisa pulsa %u, pembayaran %u\n", RELAY_GPIO, remain, payId);
  if (!serverBase.startsWith("http://")) {
    Serial.println("SERVER_URL harus http:// di jaringan lokal");
  }
}

void loop() {
  serviceRelay();
  if (phase == PHASE_ON) {
    delay(1);
    return;
  }
  ensureWifi();
  serviceServer();
}
