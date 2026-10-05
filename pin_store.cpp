#include "pin_store.h"
#include <LittleFS.h>
#include <Preferences.h>
#include <esp_random.h>
#include <time.h>
#include "mbedtls/pkcs5.h"

// Format pliku jest binarny i stalej dlugosci — zmiana rozmiaru rekordu unieważnia
// caly /pins.db. Gdyby kiedys trzeba bylo dolozyc pole, trzeba podbic wersje formatu
// i skasowac plik przy starcie, a nie liczyc na to, ze sie ulozy.
static_assert(sizeof(FsPin) == 76, "zmienil sie rozmiar FsPin - /pins.db z poprzednich wersji jest nieczytelny");

// Z access_control.ino: stan montowania systemu plików, dziennik i znaczniki
// operacji na flashu (okruszki RTC, README §5.13).
extern bool fsMounted;
extern void addLog(String msg);
extern void flashOpBegin(uint8_t kind);
extern void flashOpEnd();

static uint8_t pinSalt[16];
static bool    pinSaltReady = false;

String pinSaltHex() {
  if (!pinSaltReady) return "";
  char h[33];
  for (int i = 0; i < 16; i++) sprintf(h + i * 2, "%02x", pinSalt[i]);
  h[32] = 0;
  return String(h);
}

void loadOrCreatePinSalt() {
  Preferences p;
  p.begin("ctrlsec", false);
  size_t got = p.getBytes("pinsalt", pinSalt, sizeof(pinSalt));
  if (got != sizeof(pinSalt)) {
    esp_fill_random(pinSalt, sizeof(pinSalt));
    flashOpBegin(3);
    p.putBytes("pinsalt", pinSalt, sizeof(pinSalt));
    flashOpEnd();
    Serial.println("[PIN] Wygenerowano nowa sol urzadzenia.");
  }
  p.end();
  pinSaltReady = true;
}

static bool pbkdf2Pin(const String& pin, uint8_t out[32]) {
  if (!pinSaltReady || pin.length() == 0) return false;
  return mbedtls_pkcs5_pbkdf2_hmac_ext(MBEDTLS_MD_SHA256,
                                       (const unsigned char*)pin.c_str(), pin.length(),
                                       pinSalt, sizeof(pinSalt),
                                       PIN_PBKDF2_ITER, 32, out) == 0;
}

// Porównanie w stałym czasie — nie zdradza, ile bajtów hasha się zgadza.
static bool hashEquals(const uint8_t a[32], const uint8_t b[32]) {
  uint8_t d = 0;
  for (int i = 0; i < 32; i++) d |= a[i] ^ b[i];
  return d == 0;
}

int pinCount() {
  if (!fsMounted || !LittleFS.exists(PINS_DB_PATH)) return 0;
  File f = LittleFS.open(PINS_DB_PATH, "r");
  if (!f) return 0;
  int n = f.size() / sizeof(FsPin);
  f.close();
  return n;
}

static bool pinRead(int idx, FsPin& out) {
  if (!fsMounted || idx < 0) return false;
  File f = LittleFS.open(PINS_DB_PATH, "r");
  if (!f) return false;
  bool ok = false;
  if ((size_t)(idx + 1) * sizeof(FsPin) <= f.size() && f.seek(idx * sizeof(FsPin)))
    ok = (f.read((uint8_t*)&out, sizeof(out)) == (int)sizeof(out));
  f.close();
  return ok;
}

// Nadpisanie rekordu w miejscu — używane przy zliczaniu użyć kodu gościnnego.
static bool pinWriteAt(int idx, const FsPin& rec) {
  if (!fsMounted || idx < 0) return false;
  File f = LittleFS.open(PINS_DB_PATH, "r+");
  if (!f) return false;
  bool ok = false;
  if (f.seek(idx * sizeof(FsPin))) {
    flashOpBegin(2);
    ok = (f.write((const uint8_t*)&rec, sizeof(rec)) == sizeof(rec));
    flashOpEnd();
  }
  f.close();
  return ok;
}

static int pinFindById(uint32_t id) {
  int n = pinCount();
  FsPin r;
  for (int i = 0; i < n; i++)
    if (pinRead(i, r) && r.id == id) return i;
  return -1;
}

bool pinUpsert(const FsPin& rec) {
  if (!fsMounted) return false;
  int idx = pinFindById(rec.id);
  if (idx >= 0) return pinWriteAt(idx, rec);
  if (pinCount() >= HW_MAX_PINS) {
    addLog("PIN odrzucony: limit " + String(HW_MAX_PINS));
    return false;
  }
  File f = LittleFS.open(PINS_DB_PATH, "a");
  if (!f) return false;
  flashOpBegin(2);
  bool ok = (f.write((const uint8_t*)&rec, sizeof(rec)) == sizeof(rec));
  flashOpEnd();
  f.close();
  return ok;
}

// Kasowanie: przepisanie pliku bez jednego rekordu. Operacje na PIN-ach są rzadkie,
// więc prostota wygrywa z optymalizacją (brak listy wolnych miejsc).
bool pinDeleteById(uint32_t id) {
  int n = pinCount();
  if (n <= 0) return false;
  int idx = pinFindById(id);
  if (idx < 0) return false;
  File src = LittleFS.open(PINS_DB_PATH, "r");
  File dst = LittleFS.open("/pins.tmp", "w");
  if (!src || !dst) { if (src) src.close(); if (dst) dst.close(); return false; }
  FsPin r;
  flashOpBegin(2);
  for (int i = 0; i < n; i++) {
    if (src.read((uint8_t*)&r, sizeof(r)) != (int)sizeof(r)) break;
    if (i != idx) dst.write((const uint8_t*)&r, sizeof(r));
  }
  flashOpEnd();
  src.close(); dst.close();
  LittleFS.remove(PINS_DB_PATH);
  return LittleFS.rename("/pins.tmp", PINS_DB_PATH);
}

PinResult verifyPinLocal(const String& pin, String& ownerOut) {
  int n = pinCount();
  if (n <= 0) return PIN_BRAK;
  uint8_t h[32];
  if (!pbkdf2Pin(pin, h)) return PIN_BRAK;

  FsPin r;
  for (int i = 0; i < n; i++) {
    if (!pinRead(i, r)) break;
    if (!hashEquals(h, r.hash)) continue;

    ownerOut = String(r.name);
    if (!r.active) return PIN_NIEAKTYWNY;

    time_t now; time(&now);
    bool timeOk = (now >= 100000000);          // ten sam próg co w cardAllowedNow()
    if (r.expiresAt) {
      if (!timeOk) return PIN_BRAK_CZASU;      // fail-closed, jak przy kartach
      if ((uint32_t)now > r.expiresAt) return PIN_WYGASL;
    }
    if (r.maxUses && r.useCount >= r.maxUses) return PIN_LIMIT_UZYC;
    if (r.schEnabled) {
      if (!timeOk) return PIN_BRAK_CZASU;
      struct tm t; localtime_r(&now, &t);
      if (!(r.schDays & (1 << t.tm_wday))) return PIN_HARMONOGRAM;
      int m = t.tm_hour * 60 + t.tm_min;
      if (!(m >= r.schStart && m < r.schEnd)) return PIN_HARMONOGRAM;
    }
    if (r.maxUses) {                           // licznik użyć przeżywa restart
      r.useCount++;
      pinWriteAt(i, r);
    }
    return PIN_OK;
  }
  return PIN_BRAK;
}
