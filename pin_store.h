// =========================================================================
// CTRLABLE Node — magazyn PIN-ów i weryfikacja LOKALNA (etap 2, v3.3.0)
//
// Do v3.2.7 PIN sprawdzał serwer (POST /api/auth/keypad), więc przy braku Wi-Fi
// klawiatura była martwa. Teraz centralka trzyma hashe u siebie i decyduje sama;
// serwer jest potrzebny tylko do zakładania i zmiany kodów.
//
// Dlaczego PBKDF2 z JEDNĄ solą urządzenia, a nie bcrypt jak na serwerze:
// bcrypt ma sól per rekord, więc sprawdzenie N kodów wymaga N pełnych przeliczeń —
// przy 500 PIN-ach to minuty. Jedna sól urządzenia pozwala policzyć hash RAZ
// i porównać go z każdym rekordem (porównanie w stałym czasie).
//
// Konsekwencja, którą trzeba znać: serwer trzyma bcrypt i NIE POTRAFI odtworzyć
// jawnego PIN-u, więc nie da się przenieść istniejących kodów automatycznie.
// Hash liczony tą solą powstaje po stronie serwera w chwili zakładania/zmiany
// kodu i przychodzi komendą "P". Kody założone wcześniej działają dalej przez
// serwer (gdy jest sieć), ale offline zaczną działać dopiero po jednorazowym
// ustawieniu na nowo w aplikacji.
//
// Osobny moduł, a nie kolejny blok w szkicu, z powodu czysto technicznego:
// Arduino i PlatformIO generują prototypy funkcji na górze pliku .ino, zanim
// poznają typy zdefiniowane w jego środku — funkcja biorąca FsPin nie ma prawa
// tam mieszkać.
// =========================================================================
#pragma once
#include <Arduino.h>

// Sufit sprzętowy PIN-ów. 500 × sizeof(FsPin) ≈ 38 KB z 384 KB partycji LittleFS.
#ifndef HW_MAX_PINS
#define HW_MAX_PINS 500
#endif

// Liczba iteracji PBKDF2. SHA-256 na ESP32 jest sprzętowe; 20 000 iteracji to
// szacunkowo ~0,2 s na wpisanie kodu — DO POTWIERDZENIA POMIAREM na płytce.
// Chroni przed zgadywaniem po wymontowaniu flasha; zgadywanie „od frontu"
// ogranicza blokada po 5 próbach.
#ifndef PIN_PBKDF2_ITER
#define PIN_PBKDF2_ITER 20000
#endif

#define PINS_DB_PATH "/pins.db"

// Rekord na dysku. Stała długość — plik skanuje się sekwencyjnie, bez indeksu.
struct FsPin {
  uint32_t id;            // id rekordu z serwera (keypad_pins.id) — po nim adresowane są komendy
  uint8_t  hash[32];      // PBKDF2-HMAC-SHA256(pin, sól urządzenia); jawny PIN nigdy nie jest zapisywany
  char     name[24];
  uint8_t  active;
  uint8_t  isGuest;       // kod gościnny — flaga informacyjna
  uint8_t  schEnabled;
  uint8_t  schDays;       // bitmaska dni (bit0=Nd..bit6=Sb)
  uint16_t schStart;      // minuty od północy
  uint16_t schEnd;
  uint32_t expiresAt;     // epoch, 0 = bez wygasania
  uint16_t maxUses;       // 0 = bez limitu
  uint16_t useCount;
};

enum PinResult {
  PIN_BRAK,          // kodu nie ma w pamięci lokalnej
  PIN_OK,
  PIN_NIEAKTYWNY,
  PIN_WYGASL,
  PIN_LIMIT_UZYC,
  PIN_HARMONOGRAM,
  PIN_BRAK_CZASU     // harmonogram albo data ważności bez zegara → fail-closed
};

void   loadOrCreatePinSalt();          // wołać PO włączeniu radia (esp_random)
String pinSaltHex();                   // sól jest jawna — serwer musi ją znać
int    pinCount();
bool   pinUpsert(const FsPin& rec);    // dodaje albo podmienia rekord o tym samym id
bool   pinDeleteById(uint32_t id);
PinResult verifyPinLocal(const String& pin, String& ownerOut);
