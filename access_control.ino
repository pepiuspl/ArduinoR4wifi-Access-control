#include <Wire.h> 
#include <Adafruit_GFX.h> 
#include <Adafruit_SH110X.h>  
#include <SPI.h> 
#include <MFRC522.h> 
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <LittleFS.h>
#include <WiFiUdp.h>
#include <NTPClient.h> 
#include <EEPROM.h>
#include <Update.h>
#include <Preferences.h>       // NVS — klucz urządzenia i hasło sieci konfiguracyjnej
#include <esp_random.h>
#include "mbedtls/sha256.h"    // weryfikacja podpisu aktualizacji OTA
#include "mbedtls/pk.h"
#include "mbedtls/base64.h"
#include <time.h>

// STRUKTURA SERWERA ZABLOKOWANA NA TWARDO
#define PROXMOX_SERVER "node.ctrlable.pl"
#define PROXMOX_PORT   443   // TLS przez NPM (Let's Encrypt). Ruch do chmury szyfrowany.

// === Root CA Let's Encrypt (ISRG Root X1) ===
// ⚠️ WYMAGANE PRZED KOMPILACJĄ: wklej poniżej PEŁNY, dokładny PEM ISRG Root X1.
// Pobierz z zaufanego źródła: https://letsencrypt.org/certs/isrgrootx1.pem
// albo wyciągnij root z łańcucha serwera (weź OSTATNI cert = root):
//   openssl s_client -connect node.ctrlable.pl:443 -showcerts </dev/null
// Cert liścia LE rotuje co ~90 dni, ale root jest stabilny latami — nie trzeba go zmieniać.
static const char* ROOT_CA_LE = R"EOF(
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
)EOF";

// Konfiguracja klienta TLS: walidacja serwera po root CA + limity czasu,
// żeby nieudany handshake nie zawieszał pętli głównej.
static void configureSecure(WiFiClientSecure &c) {
  c.setCACert(ROOT_CA_LE);
  c.setHandshakeTimeout(6);   // sekundy na handshake TLS
  c.setTimeout(6000);         // ms na operacje we/wy
}

// === Klucz publiczny do weryfikacji aktualizacji (ECDSA P-256, README §7.5) ===
// Obraz firmware z serwera jest instalowany TYLKO, gdy podpis (nagłówek
// X-Firmware-Signature) zgadza się z tym kluczem. Klucz prywatny NIGDY nie trafia do
// repozytorium — leży w sekrecie FIRMWARE_SIGNING_KEY w GitHub Actions, który podpisuje
// każdy build. Przejęcie serwera ani konta GitHub bez tego klucza nie pozwala wgrać
// na zamki własnego oprogramowania.
static const char* FIRMWARE_PUBKEY_PEM = R"EOF(
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE40/xrgzoPS6nUe7HnO9bBzzrm0EY
51xGV2nC8+ZJ8fJz5uXJ/3WiE5UZ3nZfHW8F/IHFgNLUXMXebB2Ql+u6Ww==
-----END PUBLIC KEY-----
)EOF";

// === Sekrety urządzenia (NVS, przetrwają reset fabryczny) — README §7.2 ===
// deviceKeyHex — 32 losowe bajty (hex). Dołączany do KAŻDEGO żądania do serwera
//   (nagłówek X-Device-Key, po TLS). Zastępuje dawne „hasło" wyliczane z MAC-a jawnym
//   algorytmem — MAC widać w eterze, a algorytm był w publicznym repo.
// apPassword — hasło WPA2 sieci CTRLABLE_SETUP (12 znaków). Pokazywane na ekranie
//   WYŁĄCZNIE w trybie pierwszej konfiguracji; dawniej sieć była całkiem otwarta.
String deviceKeyHex = "";
String apPassword = "";
// localAdminPass — hasło lokalnego API w trybie offline (EEPROM @400, 16 znaków).
//   Losowane przy każdej konfiguracji offline, kasowane resetem fabrycznym.
char localAdminPass[24] = "";
#define LOCAL_PASS_ADDR 400

static const char PW_ALPHABET[] = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // bez 0/O/1/I/L

String randomToken(int len) {
  String s = "";
  for (int i = 0; i < len; i++) s += PW_ALPHABET[esp_random() % (sizeof(PW_ALPHABET) - 1)];
  return s;
}

// Wywoływać PO włączeniu radia (WiFi.mode) — wtedy esp_random() to sprzętowy RNG.
void loadOrCreateDeviceSecrets() {
  Preferences prefs;
  prefs.begin("ctrlsec", false);
  deviceKeyHex = prefs.getString("dkey", "");
  if (deviceKeyHex.length() != 64) {
    uint8_t raw[32];
    esp_fill_random(raw, sizeof(raw));
    char hex[65];
    for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", raw[i]);
    hex[64] = 0;
    deviceKeyHex = String(hex);
    prefs.putString("dkey", deviceKeyHex);
    Serial.println("[SEC] Wygenerowano nowy klucz urzadzenia.");
  }
  apPassword = prefs.getString("appw", "");
  if (apPassword.length() < 8) {
    apPassword = randomToken(12);
    prefs.putString("appw", apPassword);
  }
  prefs.end();
  // Tylko port szeregowy (fizyczny dostęp do płytki) — dla instalatora.
  Serial.println("[SEC] Siec konfiguracyjna: CTRLABLE_SETUP, haslo: " + apPassword);
}

void loadLocalAdminPass() {
  EEPROM.get(LOCAL_PASS_ADDR, localAdminPass);
  localAdminPass[sizeof(localAdminPass) - 1] = 0;
  // Po resecie fabrycznym EEPROM to same 0xFF — wszystko spoza alfabetu = brak hasła.
  for (int i = 0; localAdminPass[i]; i++) {
    if (!isalnum((unsigned char)localAdminPass[i])) { localAdminPass[0] = 0; break; }
  }
  if (strlen(localAdminPass) < 12) localAdminPass[0] = 0;
}

void saveLocalAdminPass(const String& p) {
  memset(localAdminPass, 0, sizeof(localAdminPass));
  p.toCharArray(localAdminPass, sizeof(localAdminPass));
  EEPROM.put(LOCAL_PASS_ADDR, localAdminPass);
  EEPROM.commit();
}

// Porównanie w stałym czasie — nie zdradza długości zgodnego prefiksu.
bool secureEquals(const String& a, const char* b) {
  size_t la = a.length(), lb = strlen(b);
  if (la == 0 || lb == 0) return false;
  uint8_t diff = (la == lb) ? 0 : 1;
  for (size_t i = 0; i < la; i++) diff |= (uint8_t)a[i] ^ (uint8_t)b[i % lb];
  return diff == 0;
}

void startSetupAP() {
  WiFi.softAP("CTRLABLE_SETUP", apPassword.c_str());
}

// Nagłówek uwierzytelniający centralkę — do KAŻDEGO żądania do serwera.
void printDeviceAuthHeader(WiFiClientSecure& c) {
  c.print("X-Device-Key: "); c.println(deviceKeyHex);
}

String htmlEscape(const String& s) {
  String o = "";
  for (unsigned int i = 0; i < s.length(); i++) {
    char ch = s[i];
    if (ch == '&') o += "&amp;"; else if (ch == '<') o += "&lt;"; else if (ch == '>') o += "&gt;";
    else if (ch == '\'') o += "&#39;"; else if (ch == '"') o += "&quot;"; else o += ch;
  }
  return o;
}

// Weryfikacja podpisu obrazu: hash liczony w trakcie pobierania, podpis z nagłówka.
bool verifyFirmwareSignature(const uint8_t hash[32], const String& sigB64) {
  if (sigB64.length() < 16 || sigB64.length() > 200) return false;
  uint8_t sig[160];
  size_t sigLen = 0;
  if (mbedtls_base64_decode(sig, sizeof(sig), &sigLen, (const unsigned char*)sigB64.c_str(), sigB64.length()) != 0) return false;
  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  int rc = mbedtls_pk_parse_public_key(&pk, (const unsigned char*)FIRMWARE_PUBKEY_PEM, strlen(FIRMWARE_PUBKEY_PEM) + 1);
  if (rc == 0) rc = mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, hash, 32, sig, sigLen);
  mbedtls_pk_free(&pk);
  return rc == 0;
}

unsigned long lastOtaCheck = 0;
const unsigned long otaInterval = 10000;
volatile int latestFirmwareReleaseId = 0;
unsigned long installedReleaseId = 0;
volatile unsigned long autoLockDelayMs = 3000;  // domyslne 3s, nadpisywane z serwera (networkTask)
const char* app_version = "v3.1.0";   // JEDYNE zrodlo wersji: CI bierze ja stad do tagu, nazwy wydania i pliku .bin (README §5.3)

struct User { 
  byte uid[4]; 
  char name[16];
}; 

struct LogEntry {  
  String time;  
  String msg;
}; 

// Forward Declarations
String getFormattedSystemTime(); 
String getMacAddressString();
void addLog(String msg); 
void openDoor(String source); 
void forceHardwareRFIDReset(); 
void displayProvisioningInstructions(String errorContext = "");
void saveConfiguration(String newSSID, String newPass); 
void factoryResetSettings(); 
void loadConfiguration(); 
void loadCards();
int saveNewCard(byte* uid, String nameStr);
void deleteUser(int index);
void initStorage();          // LittleFS (etap 1)
void storageSelfTest();
void updateDisplay(String status, String info = ""); 
void renderSystemUI(); 
void handleLocalHttp();
void serveProvisioning(WiFiClient& client, const String& reqHeader);
void serveLocalApi(WiFiClient& client, const String& reqHeader);
void applyPendingCommands();
void buildDiagnosticReport(int mode);
void sendDiagnosticReport();
void executeCloudSynchronization();
void performLocalFirmwareUpdate(); 
void transmitCardPayloadToCloud(String uidStr, String nameStr, int slot, bool runRegister);
void sendRemoteLog(String message);
void sendTamperAlert(bool active);
void checkTamper();
char scanKeypad();
void checkKeypad();
void handleKeypress(char key);
void verifyKeypadPIN(const String& pin);
void relayActivate();
void relayDeactivate();
void logKeypadEvent(String message); 
String urlDecode(String str);
String urlEncode(String str); 

String urlEncode(String str) { 
  String encoded = ""; 
  char c; 
  char hex[3];
  for (unsigned int i = 0; i < str.length(); i++) { 
    c = str[i];
    if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') { 
      encoded += c;
    } else if (c == ' ') { 
      encoded += '+';
    } else { 
      sprintf(hex, "%%%02X", c); 
      encoded += hex;
    } 
  } 
  return encoded; 
} 

char ssid[32] = ""; 
char pass[32] = "";
char owner_email[64] = "";

#define RELAY_PIN   13  
#define BUTTON_PIN  33   
#define LED_GREEN   25   
#define LED_RED     26   
#define BUZZER_PIN  27   
#define RST_PIN     4
#define SS_PIN      5

// ─── DEDYKOWANY PRZYCISK FACTORY RESET ───────────────────────────────────────
//   Osobny przycisk (nie miesza się z BUTTON_PIN 33 = otwórz/Uczenie).
//   GPIO39 (VN) jest WEJŚCIOWY-TYLKO i NIE MA wewnętrznego pull-upa → WYMAGA
//   ZEWNĘTRZNEGO rezystora 10 kΩ do 3.3 V (jak wiersze klawiatury 34/35).
//   Podłączenie: przycisk między GPIO39 a GND; 10 kΩ między GPIO39 a 3.3 V.
//   W spoczynku pin = HIGH; wciśnięty = LOW. Przytrzymaj 3 s → reset fabryczny.
#define RESET_BTN_PIN   39

// ─── ANTI-TAMPER ─────────────────────────────────────────────────────────────
//   Ustaw TAMPER_INSTALLED na true dopiero PO fizycznym zamontowaniu przełącznika NC.
//   Bez przełącznika: IO14 = floating HIGH → fałszywy alarm przy każdym starcie!
// When installing tamper switch on IO36: add external 10kΩ pull-up to 3.3V
#define TAMPER_PIN       32  // IO36 — input-only, no conflict with RELAY_PIN 13
#define TAMPER_INSTALLED true   // ← zmień na true gdy przełącznik NC jest zainstalowany
#define KEYPAD_INSTALLED true    // klawiatura podłączona
//  Pin 1 → IO16 (kol: 1 4 7 *)
//  Pin 2 → IO17 (kol: 2 5 8 0)
//  Pin 3 → IO12 (kol: 3 6 9 #)  ← był IO2 (dioda!), teraz IO12
//  Pin 4 → IO2  (wiersz: 1 2 3, INPUT_PULLUP — dioda praktycznie wygaszona)  ← był IO12
//  Pin 5 → IO15 (wiersz: 4 5 6, wewn. pull-up)
//  Pin 6 → IO35 (wiersz: 7 8 9, ZEWN. 10kΩ do 3.3V!)
//  Pin 7 → IO34 (wiersz: * 0 #, ZEWN. 10kΩ do 3.3V!)
#define KP_COL1  16
#define KP_COL2  17
#define KP_COL3  12   // connector pin 5 — col right (3 6 9 #)  [was IO2 = LED pin!]
#define KP_ROW1  14   // connector pin 2 — row 1 (1 2 3)  ← MOVE WIRE from IO2 to IO14
                      // IO2 has the onboard blue LED; its LED circuit pulls IO2 to ~2V
                      // which is below ESP32's HIGH threshold → always reads LOW → constant beeping
                      // IO14 has no LED, internal pull-up works correctly
#define KP_ROW2  15
#define KP_ROW3  34   // IO34 — external 10kΩ to 3.3V (or use INPUT_PULLUP)
#define KP_ROW4  35   // IO35 — external 10kΩ to 3.3V (or use INPUT_PULLUP)

const uint8_t KP_COLS[3] = { KP_COL1, KP_COL2, KP_COL3 };
const uint8_t KP_ROWS[4] = { KP_ROW1, KP_ROW2, KP_ROW3, KP_ROW4 };
const char    KP_MAP[4][3] = {
  { '1','2','3' },
  { '4','5','6' },
  { '7','8','9' },
  { '*','0','#' }
};

#define MAX_LOGS 30  
#define OLED_RESET -1  

Adafruit_SH1106G display = Adafruit_SH1106G(128, 64, &Wire, OLED_RESET);
MFRC522 rfid(SS_PIN, RST_PIN); 
WiFiUDP ntpUDP; 
NTPClient timeClient(ntpUDP, "europe.pool.ntp.org", 7200);
WiFiServer server(80);  

volatile bool doorOpen = false;
volatile bool learningMode = false;
bool autoExitLearn = false;  
bool provisioningMode = false;
bool isOfflineStandby = false;  
bool hasSavedConfig = false;
bool oledConnected = false; 
// Sufit sprzętowy kart w trybie online (magazyn LittleFS). Prowizorycznie 200 =
// górny tier "individual"; do walidacji na bench (RAM/czas skanu). Realny limit
// i tak narzuca licencja serwera. Przy braku LittleFS spadamy do starego limitu
// 10 (EEPROM) — patrz loadCards()/saveNewCard().
#define HW_MAX_CARDS 200
User users[HW_MAX_CARDS];
bool isCardActive[HW_MAX_CARDS];
// Harmonogramy kart trzymamy w RÓWNOLEGŁYCH tablicach, a nie w strukturze User —
// User jest zapisywany do EEPROM-u w trybie awaryjnym pod offsetem 10 (10 rekordów
// po 20 B), więc jej poszerzenie nadpisałoby tablicę isCardActive spod offsetu 220.
// Na dysku harmonogram i tak mieszka w FsCard (LittleFS), gdzie pola już były.
// W trybie awaryjnym (EEPROM) harmonogramów nie ma — karty działają jak dotąd.
uint8_t  cardSchEnabled[HW_MAX_CARDS];
uint8_t  cardSchDays[HW_MAX_CARDS];    // bitmaska: bit0=Niedziela … bit6=Sobota
uint16_t cardSchStart[HW_MAX_CARDS];   // minuty od północy
uint16_t cardSchEnd[HW_MAX_CARDS];
int totalCards = 0;
String pendingUsername = "Nowy Uzytkownik";  
String globalDisplayInfo = "";  

LogEntry lastActions[MAX_LOGS];  
int logCount = 0; 

int failedLoginAttempts = 0;
unsigned long lockoutEndTime = 0; 
unsigned long accessEndTime = 0; 
bool rfidResetPending = false; 
unsigned long lastScanTime = 0;
unsigned long lastWifiRetryTime = 0;  
unsigned long lastRfidWatchdogTime = 0;  
unsigned long lastPollTime = 0;
int pollFailStreak = 0;   // ile pollów z rzędu nie połączyło się — backoff interwału (networkTask)

// --- Dwurdzeniowość: task SIECIOWY na rdzeniu 0, cały SPRZĘT (RFID/przekaźnik/
// dźwięk/OLED) na rdzeniu 1 (loop). Poll NIE dotyka sprzętu — ustawia flagi,
// które loop wykonuje. Blokujący handshake TLS nigdy nie zamraża skanu karty
// (karty i tak matchowane lokalnie → dostęp niezależny od serwera). Flagi
// proste (bool/32-bit) = atomowe na ESP32; pendingUsername pisze TYLKO loop. ---
volatile bool req_unlock = false;
volatile bool req_ota = false;
volatile bool req_deregister = false;
volatile bool req_usernameUpdated = false;
char req_username[40] = "";
// Komendy z serwera (zmiany kart, Wi-Fi) — README §7.3. networkTask odkłada porcję
// tutaj, a WYKONUJE ją loop (rdzeń 1), bo dotyka tablic kart używanych przy skanie.
// cmdAckId = najwyższy wykonany id; wysyłany w każdym pollu jako ack.
volatile bool req_cmdsPending = false;
char req_cmds[1024] = "";
volatile unsigned long cmdAckId = 0;
volatile unsigned long restartAfterAckId = 0;   // po komendzie Wi-Fi/restart: restart dopiero, gdy serwer dostał ack
// Tryb serwisowy (README §7.15): kod obecności z serwera pokazywany na OLED przez 15 min.
char serviceCode[8] = "";
unsigned long serviceCodeUntil = 0;
// Raport diagnostyczny/self-test: loop (rdzeń 1) buduje JSON i ustawia flagę,
// networkTask (rdzeń 0) tylko go wysyła — bez wyścigu o tablice kart.
volatile bool req_diagReport = false;
String diagPayload = "";
volatile unsigned long lastAckSent = 0;          // ack z ostatniego UDANEGO polla (HTTP 200)
unsigned long lastAuthRejectLog = 0;
// --- Kolejka wysyłki skanu karty do chmury (rdzeń 1 -> rdzeń 0) --------------
// KRYTYCZNE DLA SZYBKOŚCI: transmitCardPayloadToCloud() robi pełny handshake TLS
// (realnie 1,5–4 s). Wołane wprost z loop() zamrażało rdzeń 1 na każdym skanie —
// dioda przestawała migać, OLED stał, a potwierdzenie „DODANO KARTE" pojawiało się
// po kilku sekundach. Wyglądało to jak wolne czytanie karty, choć odczyt jest
// natychmiastowy. Teraz loop() tylko odkłada dane tutaj, a TLS robi networkTask.
volatile bool req_cardUpload = false;
volatile bool req_buttonLog = false;   // log naciśnięcia przycisku — wysyła rdzeń 0
char  up_uid[32] = "";
char  up_name[40] = "";
volatile int  up_slot = 0;
volatile bool up_register = false;
TaskHandle_t networkTaskHandle = NULL;
unsigned long lastSuccessfulPollTime = 0;
int globalAnimFrame = 0; 
unsigned long lastFrameTick = 0; 

bool blockTelemetry = false;
bool systemWasOnline = false;
// Gdy true, najbliższa iteracja loop() wykona executeCloudSynchronization()
// OD RAZU (poza normalnym 1s cyklem), żeby serwer/aplikacja jak najszybciej
// zobaczyły prawdziwy, potwierdzony przez sprzęt stan rygla.
volatile bool forceSyncNow = false;

// Status magazynu LittleFS (etap 1a) — ustawiany w initStorage()/storageSelfTest(),
// wysyłany raz do logu serwera po połączeniu WiFi (Serial nie jest dostępny zdalnie).
bool     fsMounted = false;
bool     fsSelfTestPass = false;
uint32_t fsTotalBytes = 0;
uint32_t fsUsedBytes = 0;
bool     fsStatusReported = false;

// ─── ZMIENNE ANTI-TAMPER ──────────────────────────────────────────────────────
bool tamperActive            = false;
unsigned long lastTamperPost = 0;
const unsigned long TAMPER_REPEAT_MS = 30000;

// ─── ZMIENNE KLAWIATURA ───────────────────────────────────────────────────────
String        kpBuffer    = "";
unsigned long kpLastKey   = 0;
char          kpLastChar  = 0;
unsigned long kpLastPress = 0;
bool          kpChecking  = false;
const unsigned long KP_TIMEOUT_MS  = 10000;
const unsigned long KP_DEBOUNCE_MS = 200;
const int           KP_MAX_LEN     = 8;

String urlDecode(String str) { 
  String decoded = ""; 
  int i = 0;
  while (i < str.length()) { 
    if (str[i] == '+') { 
      decoded += ' ';
      i++;
    } else if (str[i] == '%') { 
      if (i + 2 < str.length()) { 
        char high = str[i+1];
        char low = str[i+2]; 
        int value = 0; 
        if (high >= '0' && high <= '9') value += (high - '0') * 16;
        else if (high >= 'A' && high <= 'F') value += (high - 'A' + 10) * 16;
        else if (high >= 'a' && high <= 'f') value += (high - 'a' + 10) * 16;
        if (low >= '0' && low <= '9') value += (low - '0');
        else if (low >= 'A' && low <= 'F') value += (low - 'A' + 10);
        else if (low >= 'a' && low <= 'f') value += (low - 'a' + 10); 
        decoded += (char)value;
        i += 3; 
      } else { 
        decoded += '%'; 
        i++;
      } 
    } else { 
      decoded += str[i]; 
      i++;
    } 
  } 
  return decoded; 
} 

String getMacAddressString() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char macBuf[18];
  sprintf(macBuf, "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(macBuf);
}

// (Dawne getFactoryAdminPassword() usunięte: „CN” + suma kodów znaków MAC-a z jawną
// solą — ~10 tys. możliwych wartości, a MAC widać w eterze. Zastąpione losowym
// kluczem urządzenia i losowym hasłem lokalnym — patrz loadOrCreateDeviceSecrets().)

void loadConfiguration() { 
  if (EEPROM.read(250) == 0x55) { 
    EEPROM.get(260, ssid);
    EEPROM.get(292, pass); 
    EEPROM.get(324, owner_email); // 🌟 Odczyt emaila z adresu 324
    provisioningMode = false;  
    hasSavedConfig = true;
  } else { 
    provisioningMode = true;  
    hasSavedConfig = false; 
  } 
} 

void saveConfiguration(String newSSID, String newPass, String newEmail) { 
  newSSID.toCharArray(ssid, 32);
  newPass.toCharArray(pass, 32); 
  newEmail.toCharArray(owner_email, 64); 
  EEPROM.put(260, ssid); 
  EEPROM.put(292, pass); 
  EEPROM.put(324, owner_email); 
  EEPROM.write(250, 0x55);  
  EEPROM.commit(); 
} 

void factoryResetSettings() {
  for (int i = 0; i < 512; i++) {
    EEPROM.write(i, 0xFF);
  }
  EEPROM.put(0, 0);
  // ID wgranego build-u MUSI wrócić do 0, nie zostać jako 0xFFFFFFFF po wyczyszczeniu.
  // Inaczej centralka raportuje release_id=4294967295, serwer porównuje
  // (latest > installed) i uznaje, że urządzenie ma NOWSZY soft niż jakikolwiek
  // release → aplikacja pokazuje „masz najnowszy" i OTA nigdy się nie proponuje.
  EEPROM.put(480, (unsigned long)0);
  EEPROM.commit();
  // Wyczyść też magazyn LittleFS — inaczej po deregistracji karty/PIN-y wróciłyby
  // z /cards.db przy ponownej rejestracji. WiFi/owner zostają w EEPROM (już wyżej).
  if (fsMounted) {
    LittleFS.remove("/cards.db");
    LittleFS.remove("/pins.db");   // etap 2 (jeszcze nieużywany) — bezpieczne z góry
  }
}

// Format rekordów magazynu LittleFS (etap 1b/2). Zdefiniowane TU, przed
// funkcjami magazynu, by typ był znany przed użyciem (sizeof/pola).
//   /cards.db : sekwencja FsCard (stała długość, łatwe skanowanie)
//   /pins.db  : sekwencja FsPin  (hash PBKDF2, nigdy jawnie) — etap 2
struct FsCard {
  uint8_t  uidLen;        // 4 lub 7
  uint8_t  uid[7];        // UID karty/breloka
  char     name[24];      // nazwa/lokator
  uint8_t  active;        // 1 = aktywna
  uint8_t  schEnabled;    // harmonogram wł/wył
  uint8_t  schDays;       // bitmaska dni (bit0=Nd..bit6=Sb)
  uint16_t schStart;      // minuty od północy
  uint16_t schEnd;
};                        // ~40 B
struct FsPin {
  uint8_t  hash[32];      // PBKDF2-HMAC-SHA256(pin, sól per-urządzenie)
  char     name[24];
  uint8_t  active;
  uint8_t  isGuest;       // kod gościnny (tylko licencja) — flaga informacyjna
  uint8_t  schEnabled;
  uint8_t  schDays;
  uint16_t schStart;
  uint16_t schEnd;
  uint32_t expiresAt;     // epoch, 0 = bez wygasania
  uint16_t maxUses;       // 0 = bez limitu
  uint16_t useCount;
};                        // ~73 B

// --- Magazyn kart: LittleFS (etap 1b) z degradacją do EEPROM ---------------
// Format na dysku: /cards.db = sekwencja rekordów FsCard (stała długość).
// LittleFS trzyma do HW_MAX_CARDS kart; stary EEPROM (cap 10) to fallback, gdy
// LittleFS się nie zamontował (fsMounted=false) — zamek nigdy nie traci kart.
#define CARDS_DB_PATH "/cards.db"

// Zapis WSZYSTKICH kart z RAM do EEPROM (stary układ: nagłówek@0, rekordy@10,
// flagi aktywności@220). Używane tylko w trybie fallback (bez LittleFS).
void eepromPersistCards() {
  int n = totalCards; if (n > 10) n = 10;           // EEPROM mieści maks. 10
  for (int i = 0; i < n; i++) {
    EEPROM.put(10 + (i * sizeof(User)), users[i]);
    EEPROM.write(220 + i, isCardActive[i] ? 0x01 : 0x00);
  }
  EEPROM.put(0, n);
  EEPROM.commit();
}

// Odczyt kart ze starego EEPROM do RAM (stare zachowanie, cap 10).
void eepromLoadCards() {
  EEPROM.get(0, totalCards);
  if (totalCards < 0 || totalCards > 10) totalCards = 0;
  for (int i = 0; i < totalCards; i++) {
    EEPROM.get(10 + (i * sizeof(User)), users[i]);
    isCardActive[i] = (EEPROM.read(220 + i) != 0x00);
    // Tryb awaryjny nie przechowuje harmonogramów — jawnie zerujemy, żeby karta
    // nie odziedziczyła przypadkowej zawartości RAM i nie została błędnie odrzucona.
    cardSchEnabled[i] = 0;
    cardSchDays[i]    = 127;
    cardSchStart[i]   = 0;
    cardSchEnd[i]     = 1440;
  }
}

// Zrzut wszystkich kart z RAM do /cards.db (pełny rewrite — proste i bezpieczne
// dla ≤200 rekordów; LittleFS robi wear-leveling, a operacje na kartach są rzadkie).
void fsPersistCards() {
  if (!fsMounted) return;
  File f = LittleFS.open(CARDS_DB_PATH, "w");
  if (!f) { Serial.println("[FS] BLAD: nie moge zapisac /cards.db"); return; }
  for (int i = 0; i < totalCards; i++) {
    FsCard c; memset(&c, 0, sizeof(c));
    c.uidLen = 4;                                   // etap 1b: UID 4-bajtowe (jak dziś)
    memcpy(c.uid, users[i].uid, 4);
    strncpy(c.name, users[i].name, sizeof(c.name) - 1);
    c.active = isCardActive[i] ? 1 : 0;
    c.schEnabled = cardSchEnabled[i];
    c.schDays    = cardSchDays[i];
    c.schStart   = cardSchStart[i];
    c.schEnd     = cardSchEnd[i];
    f.write((const uint8_t*)&c, sizeof(c));
  }
  f.close();
}

// Wczytanie /cards.db do RAM. Zwraca false, gdy pliku nie ma (→ migracja).
bool fsLoadCards() {
  if (!fsMounted || !LittleFS.exists(CARDS_DB_PATH)) return false;
  File f = LittleFS.open(CARDS_DB_PATH, "r");
  if (!f) return false;
  totalCards = 0;
  FsCard c;
  while (totalCards < HW_MAX_CARDS &&
         f.read((uint8_t*)&c, sizeof(c)) == (int)sizeof(c)) {
    memset(&users[totalCards], 0, sizeof(User));
    memcpy(users[totalCards].uid, c.uid, 4);        // dopasowanie po 4 bajtach
    strncpy(users[totalCards].name, c.name, sizeof(users[totalCards].name) - 1);
    isCardActive[totalCards] = (c.active != 0);
    cardSchEnabled[totalCards] = c.schEnabled;
    cardSchDays[totalCards]    = c.schDays;
    cardSchStart[totalCards]   = c.schStart;
    cardSchEnd[totalCards]     = c.schEnd;
    totalCards++;
  }
  f.close();
  return true;
}

// --- Egzekwowanie harmonogramu karty (LOKALNIE, przed otwarciem) --------------
// Wcześniej harmonogram istniał tylko w bazie i w UI: serwer go zapisywał, ale
// centralka decydowała po samym UID, więc karta "tylko pn-pt 8-16" otwierała drzwi
// zawsze. To była obietnica interfejsu bez pokrycia — tu jest jej realizacja.
//
// Czas nieznany (brak NTP po restarcie) => karta z harmonogramem NIE otwiera.
// Świadomy wybór: fail-closed dotyka wyłącznie kart ograniczonych czasowo, więc
// karta właściciela (bez harmonogramu) działa zawsze i nikt nie zostaje przed drzwiami.
bool cardAllowedNow(int idx) {
  if (idx < 0 || idx >= totalCards) return false;
  if (!cardSchEnabled[idx]) return true;          // brak ograniczeń czasowych

  time_t now; time(&now);
  if (now < 100000000) {                          // zegar nieustawiony (brak NTP)
    addLog("Odmowa: brak czasu [" + String(users[idx].name) + "]");
    return false;
  }
  struct tm t; localtime_r(&now, &t);

  if (!(cardSchDays[idx] & (1 << t.tm_wday))) return false;   // dzień poza harmonogramem
  int minutesNow = t.tm_hour * 60 + t.tm_min;
  return (minutesNow >= cardSchStart[idx] && minutesNow < cardSchEnd[idx]);
}

// Jedno wejście dla wszystkich mutacji: LittleFS gdy zamontowany, inaczej EEPROM.
void persistCards() {
  if (fsMounted) fsPersistCards();
  else           eepromPersistCards();
}

void loadCards() {
  if (fsMounted) {
    if (fsLoadCards()) return;                       // LittleFS = źródło prawdy
    // Brak /cards.db → jednorazowa migracja starych kart z EEPROM.
    eepromLoadCards();
    fsPersistCards();
    Serial.print("[FS] Migracja kart EEPROM->LittleFS, przeniesiono: ");
    Serial.println(totalCards);
    return;
  }
  eepromLoadCards();                                 // fallback bez LittleFS
}

// Zwraca INDEKS slotu, pod którym karta wylądowała (albo -1, gdy brak miejsca).
// To istotne: przy deduplikacji karta trafia pod SWÓJ stary indeks, a nie na koniec.
// Zgłaszanie do chmury "totalCards-1" wpisywało wtedy do bazy zły hardware_slot_idx,
// przez co zmiana nazwy i harmonogram relayowane były do NIEWŁAŚCIWEGO slotu.
int saveNewCard(byte* uid, String nameStr) {
  int cap = fsMounted ? HW_MAX_CARDS : 10;
  // DEDUPLIKACJA: ta sama karta zbliżona ponownie w trybie uczenia NIE tworzy
  // kolejnego slotu — aktualizujemy istniejący wpis. Bez tego jeden brelok
  // lądował w bazie po kilka razy (widoczne jako 7 „użytkowników" przy 2 kartach).
  for (int i = 0; i < totalCards; i++) {
    if (memcmp(users[i].uid, uid, 4) == 0) {
      memset(users[i].name, 0, sizeof(users[i].name));
      nameStr.toCharArray(users[i].name, sizeof(users[i].name));
      isCardActive[i] = true;
      persistCards();
      return i;                       // slot ISTNIEJĄCEJ karty
    }
  }
  if (totalCards >= cap) return -1;
  memset(&users[totalCards], 0, sizeof(User));
  memcpy(users[totalCards].uid, uid, 4);
  nameStr.toCharArray(users[totalCards].name, 16);
  isCardActive[totalCards] = true;
  // Nowa karta bez ograniczeń czasowych — harmonogram włącza dopiero aplikacja.
  cardSchEnabled[totalCards] = 0;
  cardSchDays[totalCards]    = 127;   // wszystkie dni
  cardSchStart[totalCards]   = 0;
  cardSchEnd[totalCards]     = 1440;
  int newIdx = totalCards;
  totalCards++;
  persistCards();
  return newIdx;
}

void deleteUser(int index) {
  if (index < 0 || index >= totalCards) return;
  for (int i = index; i < totalCards - 1; i++) {
    users[i] = users[i + 1];
    isCardActive[i] = isCardActive[i + 1];
    // Harmonogramy MUSZĄ przesunąć się razem z kartami — inaczej po usunięciu
    // jednej karty pozostałe odziedziczyłyby cudze okna czasowe.
    cardSchEnabled[i] = cardSchEnabled[i + 1];
    cardSchDays[i]    = cardSchDays[i + 1];
    cardSchStart[i]   = cardSchStart[i + 1];
    cardSchEnd[i]     = cardSchEnd[i + 1];
  }
  totalCards--;
  persistCards();
}

// ===========================================================================
// MAGAZYN LittleFS — nowy magazyn kart/PIN-ów zastępujący 512 B EEPROM.
// Etap 1a: montowanie + self-test (poniżej: storageSelfTest/initStorage).
// Etap 1b: WDROŻONY — karty żyją w /cards.db (patrz loadCards/saveNewCard/
//   persistCards wyżej), migracja z EEPROM przy pierwszym boocie, sufit
//   HW_MAX_CARDS; przy braku LittleFS degradacja do EEPROM (cap 10).
// Etap 2 (TODO): PIN-y (hash PBKDF2) w /pins.db + weryfikacja lokalna offline.
//
// FORMAT REKORDÓW (limity egzekwuje serwer wg tieru + sufit sprzętowy):
//   /cards.db : sekwencja FsCard (stała długość, łatwe skanowanie)
//   /pins.db  : sekwencja FsPin  (hash PBKDF2, nigdy jawnie)
// Struktury FsCard/FsPin są zdefiniowane WYŻEJ (tuż przed magazynem kart),
// żeby były znane kompilatorowi przed pierwszym użyciem (sizeof/pola).

void storageSelfTest() {
  const char* path = "/selftest.bin";
  uint32_t magic = 0xCAFE1234, back = 0;
  File f = LittleFS.open(path, "w");
  if (!f) { Serial.println("[FS] BLAD: nie moge otworzyc do zapisu"); return; }
  f.write((const uint8_t*)&magic, sizeof(magic));
  f.close();
  File r = LittleFS.open(path, "r");
  if (r) { r.read((uint8_t*)&back, sizeof(back)); r.close(); }
  LittleFS.remove(path);
  fsTotalBytes = LittleFS.totalBytes();
  fsUsedBytes  = LittleFS.usedBytes();
  fsSelfTestPass = (back == magic);
  Serial.print("[FS] LittleFS total="); Serial.print(LittleFS.totalBytes());
  Serial.print("B used="); Serial.print(LittleFS.usedBytes());
  Serial.print("B FsCard="); Serial.print(sizeof(FsCard));
  Serial.print("B FsPin="); Serial.print(sizeof(FsPin));
  Serial.print("B selftest="); Serial.println(back == magic ? "PASS" : "FAIL");
}

void initStorage() {
  // true = sformatuj przy pierwszym uruchomieniu / gdy montowanie się nie uda
  if (!LittleFS.begin(true)) {
    Serial.println("[FS] BLAD: LittleFS.begin nieudany — sprawdz schemat partycji (potrzebna partycja spiffs/littlefs).");
    return;
  }
  fsMounted = true;
  Serial.println("[FS] LittleFS zamontowany.");
  storageSelfTest();
}

void forceHardwareRFIDReset() {
  digitalWrite(RST_PIN, LOW); 
  delay(30); 
  digitalWrite(RST_PIN, HIGH); 
  delay(30); 
  rfid.PCD_Init();
  // Maksymalne wzmocnienie odbiornika anteny (48dB) - domyślna wartość
  // biblioteki jest zachowawcza. Pomaga przy słabszych tagach (breloki)
  // lub gdy czytnik jest fizycznie osłonięty (np. za obudową klawiatury).
  rfid.PCD_SetAntennaGain(rfid.RxGain_max);
  Serial.println("RFID INIT");
  byte v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  Serial.printf("MFRC522 version: 0x%02X\n", v);
} 

String getFormattedSystemTime() { 
  time_t now;
  struct tm timeinfo;
  time(&now);
  localtime_r(&now, &timeinfo);
  
  if (now < 100000000) return "--:--"; 
  char timeBuffer[6];
  sprintf(timeBuffer, "%02d:%02d", timeinfo.tm_hour, timeinfo.tm_min); 
  return String(timeBuffer); 
} 

void renderSystemUI() {
  if (!oledConnected) return; 
  display.clearDisplay(); 
  display.setTextSize(1); 
  display.setTextColor(SH110X_WHITE); 
  display.setCursor(2, 2);
  display.print("CTRLABLE Node "); 
  String rawVer = String(app_version); 
  if(rawVer.startsWith("v")) { 
    display.print(rawVer.substring(1));
  } else { 
    display.print(rawVer); 
  } 

  display.drawFastHLine(0, 12, 128, SH110X_WHITE);
  if (provisioningMode || isOfflineStandby) { 
    display.setCursor(0, 18); 
    display.println(globalDisplayInfo);
  }   
  else if (serviceCodeUntil > millis() && serviceCode[0]) {
    // Kod obecności dla serwisanta — przepisuje go do aplikacji, dowodząc, że stoi
    // przy centralce. Znika po 15 min albo po restarcie.
    display.setCursor(10, 16);
    display.print("TRYB SERWISOWY");
    display.setCursor(4, 27);
    display.print("Kod do aplikacji:");
    display.setTextSize(2);
    display.setCursor(28, 38);
    display.print(serviceCode);
    display.setTextSize(1);
  }
  else if (learningMode) {
    display.setCursor(20, 20);
    display.setTextSize(2);
    display.print("LEARNING"); 
    display.setTextSize(1); 
    display.setCursor(20, 42);
    display.print("Target: " + pendingUsername); 
    int rippleRadius = 4 + (globalAnimFrame % 3) * 5; 
    display.drawCircle(110, 32, rippleRadius, SH110X_WHITE);
    display.fillCircle(110, 32, 2, SH110X_WHITE); 
  }   
  else if (doorOpen) { 
    int shackleOffset = (globalAnimFrame > 4) ? 5 : globalAnimFrame; 
    display.fillRoundRect(14, 34, 22, 16, 2, SH110X_WHITE); 
    display.fillCircle(25, 40, 2, SH110X_BLACK); 
    display.drawFastVLine(25, 42, 4, SH110X_BLACK);
    display.drawCircleHelper(25, 34 - shackleOffset, 7, 1|2, SH110X_WHITE); 
    display.drawFastVLine(18, 34 - shackleOffset, 4, SH110X_WHITE);         
    display.setTextSize(2); 
    display.setCursor(48, 20); 
    display.print("OPEN"); 
    display.setTextSize(1); 
    display.setCursor(48, 40);
    display.print(globalDisplayInfo); 
    if (globalAnimFrame > 2) { 
      int checkStage = min(globalAnimFrame - 2, 6);
      display.drawLine(100, 35, 100 + min(checkStage, 3), 35 + min(checkStage, 3), SH110X_WHITE);
      if (checkStage > 3) { 
        display.drawLine(103, 38, 103 + (checkStage - 3) * 3, 38 - (checkStage - 3) * 3, SH110X_WHITE);
      } 
    } 
  }   
  else if (tamperActive) {
    display.setTextSize(1);
    display.setCursor(4, 16);  display.print("!! ALARM SABOTAZU !!");
    display.setCursor(4, 28);  display.print("Obudowa panelu RFID");
    display.setCursor(4, 38);  display.print("jest OTWARTA!");
    display.setCursor(0, 48);  display.print("Otwarto");
    display.setCursor(12, 56); display.print("ZABLOKOWANE");
   } else if (kpBuffer.length() > 0 || kpChecking) {
    display.setCursor(28, 14); display.print("Wpisz PIN:");
    display.setTextSize(2);    display.setCursor(10, 26);
    if (kpChecking) {
      display.print("...");
    } else {
      for (int i = 0; i < (int)kpBuffer.length(); i++) display.print('*');
      display.print("_");
    }
    display.setTextSize(1);
    display.setCursor(4, 44);  display.print("#=OK *=Czyszczenie");
  } else { 
    display.fillRoundRect(14, 32, 22, 18, 2, SH110X_WHITE);
    display.fillCircle(25, 39, 2, SH110X_BLACK); 
    display.drawFastVLine(25, 41, 5, SH110X_BLACK); 
    display.drawCircleHelper(25, 32, 7, 1|2, SH110X_WHITE); 
    display.drawFastVLine(18, 32, 4, SH110X_WHITE);
    display.drawFastVLine(32, 32, 4, SH110X_WHITE); 
    display.setTextSize(2); 
    display.setCursor(48, 24); 
    display.print("LOCKED"); 
  }

  display.drawFastHLine(0, 53, 128, SH110X_WHITE); 
  display.setTextSize(1); 
  display.setCursor(4, 56);
  if (WiFi.status() == WL_CONNECTED) { 
    systemWasOnline = true;
    display.print("ONLINE");
  } else if (isOfflineStandby) { 
    display.print("AP: SETUP"); 
  } else { 
    display.print("DISCONNECTED");
  } 
  String liveTime = getFormattedSystemTime(); 
  display.setCursor(94, 56); 
  display.print(liveTime); 
  display.display();
} 

void updateDisplay(String status, String info) { 
  globalDisplayInfo = info; 
  renderSystemUI();
} 

void displayProvisioningInstructions(String errorContext) {
  // Hasło sieci konfiguracyjnej pokazujemy WYŁĄCZNIE w trybie pierwszej konfiguracji
  // (nowe urządzenie albo reset fabryczny przyciskiem wewnątrz obudowy). W trybie
  // offline i w awaryjnym AP ekran przy drzwiach go nie zdradza.
  String head = (errorContext != "") ? errorContext : "INITIAL CONFIG!";
  if (provisioningMode) globalDisplayInfo = head + "\nSSID: CTRLABLE_SETUP\nHaslo: " + apPassword + "\nIP: 192.168.4.1";
  else globalDisplayInfo = head + "\nSiec: CTRLABLE_SETUP\n(haslo z instalacji)";
  renderSystemUI();
} 

void addLog(String msg) { 
  time_t now;
  struct tm timeinfo;
  time(&now);
  localtime_r(&now, &timeinfo);
  
  char timeBuffer[12];
  if (now < 100000000) {
    sprintf(timeBuffer, "00:00:00");
  } else {
    sprintf(timeBuffer, "%02d:%02d:%02d", timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec);
  }
  
  String currentTime = String(timeBuffer); 
  if (logCount < MAX_LOGS) { 
    lastActions[logCount++] = {currentTime, msg};
  } else { 
    for (int i = 0; i < MAX_LOGS - 1; i++) { 
      lastActions[i] = lastActions[i+1];
    } 
    lastActions[MAX_LOGS - 1] = {currentTime, msg}; 
  } 
}

// =========================================================================
// 🔊 NIEBLOKUJĄCY SILNIK DŹWIĘKÓW BRZĘCZYKA
// Każdy sygnał to kilka nut (różne częstotliwości + krótkie przerwy), więc
// brzmi żywo, a nie jak jeden płaski ton. Sterowanie odbywa się wyłącznie
// przez millis() - bez ŻADNEGO delay() - dzięki czemu odtwarzanie melodii
// nigdy nie zamraża skanowania RFID, przycisku czy obsługi sieci w loop().
// =========================================================================
struct SoundNote { int freq; int dur; int gap; }; // freq=0 -> cisza; gap = przerwa po nucie (ms)

enum SoundId {
  SND_NONE = 0,
  SND_ACCESS_GRANTED,
  SND_ACCESS_DENIED,
  SND_CARD_ENROLLED,
  SND_LEARN_ENTER,
  SND_LEARN_EXIT,
  SND_WIFI_CONNECTED,
  SND_WIFI_FAILED,
  SND_WIFI_RESTORED,
  SND_PROVISION_START,
  SND_OTA_START,
  SND_OTA_SUCCESS,
  SND_DELETE,
  SND_CLICK_CONFIRM,
  SND_KEY_DIGIT,
  SND_KEY_CLEAR,
  SND_KEY_SUBMIT,
  SND_TAMPER_ALARM     // 5 ostrych impulsów alarmowych
};

const SoundNote SND_DATA_ACCESS_GRANTED[]  = { {988, 70, 25}, {1318, 70, 25}, {1760, 130, 0} };           // wesoły arpeggio "wejdź"
const SoundNote SND_DATA_ACCESS_DENIED[]   = { {320, 110, 70}, {220, 110, 70}, {160, 220, 0} };           // schodzące "nie"
const SoundNote SND_DATA_CARD_ENROLLED[]   = { {988, 80, 35}, {1318, 80, 35}, {1760, 80, 35}, {2200, 220, 0} }; // 4-nutowy fanfar
const SoundNote SND_DATA_LEARN_ENTER[]     = { {1100, 90, 40}, {1500, 90, 40}, {1900, 160, 0} };
const SoundNote SND_DATA_LEARN_EXIT[]      = { {1200, 110, 55}, {800, 200, 0} };
const SoundNote SND_DATA_WIFI_CONNECTED[]  = { {784, 80, 30}, {988, 80, 30}, {1318, 90, 30}, {1568, 240, 0} };
const SoundNote SND_DATA_WIFI_FAILED[]     = { {350, 140, 60}, {260, 320, 0} };
const SoundNote SND_DATA_WIFI_RESTORED[]   = { {1100, 100, 45}, {1500, 160, 0} };
const SoundNote SND_DATA_PROVISION_START[] = { {600, 130, 90}, {760, 150, 0} };
const SoundNote SND_DATA_OTA_START[]       = { {1100, 70, 35}, {1600, 110, 0} };
const SoundNote SND_DATA_OTA_SUCCESS[]     = { {1568, 130, 50}, {1976, 130, 50}, {2349, 260, 0} };
const SoundNote SND_DATA_DELETE[]          = { {500, 80, 45}, {340, 160, 0} };
const SoundNote SND_DATA_CLICK_CONFIRM[]   = { {1200, 55, 35}, {1600, 70, 0} };
const SoundNote SND_DATA_KEY_DIGIT[]       = { {1450, 35, 0} };
const SoundNote SND_DATA_KEY_CLEAR[]       = { {900, 60, 35}, {600, 90, 0} };
const SoundNote SND_DATA_KEY_SUBMIT[]      = { {1700, 55, 25}, {2200, 95, 0} };
const SoundNote SND_DATA_TAMPER_ALARM[]    = { {1800,80,40},{1800,80,40},{1800,80,40},{1800,80,40},{1800,200,0} };

const SoundNote* activeMelody = nullptr;
int activeMelodyLen = 0;
int activeNoteIdx = -1;
unsigned long noteTimerStart = 0;
bool inNoteGapPhase = false;

void buzzerAdvanceNote() {
  activeNoteIdx++;
  if (!activeMelody || activeNoteIdx >= activeMelodyLen) {
    activeMelody = nullptr;
    noTone(BUZZER_PIN);
    return;
  }
  const SoundNote& n = activeMelody[activeNoteIdx];
  if (n.freq > 0) tone(BUZZER_PIN, n.freq, n.dur);
  else noTone(BUZZER_PIN);
  noteTimerStart = millis();
  inNoteGapPhase = false;
}

// Rozpoczyna odtwarzanie nazwanej melodii. Przerywa poprzednią, jeśli trwała.
// 🌟 UWAGA: parametr jest typu "int", nie "SoundId" - Arduino automatycznie
// generuje deklaracje (prototypy) wszystkich funkcji z .ino i wstawia je na
// samym początku pliku, ZANIM zdąży zobaczyć definicję enuma SoundId. Gdyby
// sygnatura użyła tu "SoundId", auto-wygenerowany prototyp odwoływałby się do
// typu, który w tym miejscu pliku jeszcze nie istnieje -> błąd kompilacji.
// Wartości SND_* są zwykłymi int-ami, więc wywołania (np. playSound(SND_ACCESS_GRANTED))
// działają bez zmian.
void playSound(int id) {
  switch (id) {
    case SND_ACCESS_GRANTED:  activeMelody = SND_DATA_ACCESS_GRANTED;  activeMelodyLen = sizeof(SND_DATA_ACCESS_GRANTED)/sizeof(SoundNote); break;
    case SND_ACCESS_DENIED:   activeMelody = SND_DATA_ACCESS_DENIED;   activeMelodyLen = sizeof(SND_DATA_ACCESS_DENIED)/sizeof(SoundNote); break;
    case SND_CARD_ENROLLED:   activeMelody = SND_DATA_CARD_ENROLLED;   activeMelodyLen = sizeof(SND_DATA_CARD_ENROLLED)/sizeof(SoundNote); break;
    case SND_LEARN_ENTER:     activeMelody = SND_DATA_LEARN_ENTER;     activeMelodyLen = sizeof(SND_DATA_LEARN_ENTER)/sizeof(SoundNote); break;
    case SND_LEARN_EXIT:      activeMelody = SND_DATA_LEARN_EXIT;      activeMelodyLen = sizeof(SND_DATA_LEARN_EXIT)/sizeof(SoundNote); break;
    case SND_WIFI_CONNECTED:  activeMelody = SND_DATA_WIFI_CONNECTED;  activeMelodyLen = sizeof(SND_DATA_WIFI_CONNECTED)/sizeof(SoundNote); break;
    case SND_WIFI_FAILED:     activeMelody = SND_DATA_WIFI_FAILED;     activeMelodyLen = sizeof(SND_DATA_WIFI_FAILED)/sizeof(SoundNote); break;
    case SND_WIFI_RESTORED:   activeMelody = SND_DATA_WIFI_RESTORED;   activeMelodyLen = sizeof(SND_DATA_WIFI_RESTORED)/sizeof(SoundNote); break;
    case SND_PROVISION_START: activeMelody = SND_DATA_PROVISION_START; activeMelodyLen = sizeof(SND_DATA_PROVISION_START)/sizeof(SoundNote); break;
    case SND_OTA_START:       activeMelody = SND_DATA_OTA_START;       activeMelodyLen = sizeof(SND_DATA_OTA_START)/sizeof(SoundNote); break;
    case SND_OTA_SUCCESS:     activeMelody = SND_DATA_OTA_SUCCESS;     activeMelodyLen = sizeof(SND_DATA_OTA_SUCCESS)/sizeof(SoundNote); break;
    case SND_DELETE:          activeMelody = SND_DATA_DELETE;          activeMelodyLen = sizeof(SND_DATA_DELETE)/sizeof(SoundNote); break;
    case SND_CLICK_CONFIRM:   activeMelody = SND_DATA_CLICK_CONFIRM;   activeMelodyLen = sizeof(SND_DATA_CLICK_CONFIRM)/sizeof(SoundNote); break;
    case SND_KEY_DIGIT:       activeMelody = SND_DATA_KEY_DIGIT;       activeMelodyLen = sizeof(SND_DATA_KEY_DIGIT)/sizeof(SoundNote); break;
    case SND_KEY_CLEAR:       activeMelody = SND_DATA_KEY_CLEAR;       activeMelodyLen = sizeof(SND_DATA_KEY_CLEAR)/sizeof(SoundNote); break;
    case SND_KEY_SUBMIT:      activeMelody = SND_DATA_KEY_SUBMIT;      activeMelodyLen = sizeof(SND_DATA_KEY_SUBMIT)/sizeof(SoundNote); break;
    case SND_TAMPER_ALARM:    activeMelody = SND_DATA_TAMPER_ALARM;    activeMelodyLen = sizeof(SND_DATA_TAMPER_ALARM)/sizeof(SoundNote); break;
    default: activeMelody = nullptr; activeMelodyLen = 0; break;
  }
  activeNoteIdx = -1;
  buzzerAdvanceNote();
}

// Musi być wywoływane w KAŻDEJ iteracji loop() - zero delay(). To jest to,
// co odlicza czas trwania nuty/przerwy i przechodzi do kolejnej nuty w tle,
// bez blokowania RFID, przycisku ani obsługi sieci.
void updateBuzzer() {
  if (!activeMelody) return;
  const SoundNote& n = activeMelody[activeNoteIdx];
  if (!inNoteGapPhase) {
    if (millis() - noteTimerStart >= (unsigned long)n.dur) {
      if (n.gap > 0) {
        noTone(BUZZER_PIN);
        inNoteGapPhase = true;
        noteTimerStart = millis();
      } else {
        buzzerAdvanceNote();
      }
    }
  } else {
    if (millis() - noteTimerStart >= (unsigned long)n.gap) {
      buzzerAdvanceNote();
    }
  }
}

void relayActivate() {
  // Aktywne wysterowanie HIGH (3.3V) energizuje cewke -> otwiera zamek.
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, HIGH);
}

void relayDeactivate() {
  // Aktywne wysterowanie LOW (GND) trzyma cewke nieenergizowana w spoczynku -> zamek zablokowany.
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);
}

void openDoor(String source) { 
  doorOpen = true;  
  globalAnimFrame = 0;  
  accessEndTime = millis() + autoLockDelayMs;
  globalDisplayInfo = source; 
  relayActivate();
  digitalWrite(LED_GREEN, LOW); 
  digitalWrite(LED_RED, HIGH); 
  playSound(SND_ACCESS_GRANTED); 
  forceSyncNow = true; // nie czekamy do następnego cyklu pollingu - zgłoś "opened" natychmiast
  addLog("Otwarto: " + source);
} 

// =========================================================================
// LOKALNY SERWER HTTP — README §7.1
// Działa WYŁĄCZNIE na punkcie dostępowym CTRLABLE_SETUP (pierwsza konfiguracja,
// tryb offline, awaryjne AP po utracie Wi-Fi), a ten jest zawsze za hasłem WPA2.
// W trybie online centralka w ogóle NIE nasłuchuje w sieci domowej — wcześniej
// każdy w Wi-Fi klienta mógł przez /save_setup odebrać hasło administratora,
// otworzyć drzwi przez /api/unlock albo wgrać własny firmware przez /api/update.
// Jeden dyspozytor zamiast trzech funkcji rywalizujących o to samo gniazdo.
// =========================================================================

// Wartość parametru z pierwszej linii żądania ("GET /x?a=1&b=2 HTTP/1.1").
String queryParam(const String& req, const String& key) {
  String p1 = "?" + key + "=", p2 = "&" + key + "=";
  int start = req.indexOf(p1);
  if (start != -1) start += p1.length();
  else {
    start = req.indexOf(p2);
    if (start == -1) return "";
    start += p2.length();
  }
  int end = req.length();
  int amp = req.indexOf('&', start);
  int sp = req.indexOf(' ', start);
  if (amp != -1 && amp < end) end = amp;
  if (sp != -1 && sp < end) end = sp;
  return urlDecode(req.substring(start, end));
}

void handleLocalHttp() {
  WiFiClient client = server.accept();
  if (!client) return;
  String reqHeader = "";
  unsigned long webTimeout = millis() + 1000;
  while (client.connected() && millis() < webTimeout) {
    if (client.available()) {
      char c = client.read();
      reqHeader += c;
      if (c == '\n' || reqHeader.length() > 1024) break;
    }
  }
  while (client.available()) { client.read(); }
  if (reqHeader.startsWith("GET /api/") || reqHeader.startsWith("POST /api/")) serveLocalApi(client, reqHeader);
  else serveProvisioning(client, reqHeader);
}

void serveProvisioning(WiFiClient& client, const String& reqHeader) {
  // UWAGA: pełnej linii żądania NIE logujemy — zawiera hasło Wi-Fi (p=), a dziennik
  // lokalny jest widoczny w aplikacji (dawniej: addLog("REQ=" + reqHeader)).
  if (reqHeader.indexOf("GET /save_setup") != -1 || reqHeader.indexOf("POST /save_setup") != -1) {
    String newSSID  = queryParam(reqHeader, "s");
    String newPass  = queryParam(reqHeader, "p");
    String newEmail = queryParam(reqHeader, "m");
    String offline  = queryParam(reqHeader, "offline");

    if (offline == "1" || newSSID == "OFFLINE") {
      // Tryb lokalny: NOWE losowe hasło lokalnego API przy każdej konfiguracji (dawniej
      // hasło wyliczane z MAC-a). Aplikacja zapisuje je u siebie w bezpiecznym magazynie.
      String newLocal = randomToken(16);
      saveLocalAdminPass(newLocal);
      saveConfiguration("OFFLINE_MODE", "NONE", newEmail);
      client.println("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n");
      client.println("{\"status\":\"offline_ready\",\"admin_pass\":\"" + newLocal + "\",\"mac\":\"" + getMacAddressString() + "\",\"tamper\":" + String(tamperActive ? "true" : "false") + "}");
      delay(100); client.stop();
      ESP.restart();
      return;
    }

    if (newSSID.length() == 0 || newSSID.length() > 31 || newPass.length() > 31 || newEmail.length() > 63) {
      client.println("HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nNiepoprawne dane (SSID/haslo max 31 znakow).");
      delay(10); client.stop();
      return;
    }
    // Tryb online: lokalne API wyłączone (brak hasła lokalnego) — zarządzanie wyłącznie
    // przez serwer. Dawny blok rejestrujący konto z centralki (reg_pass) usunięty:
    // aplikacja zakłada konto sama, a hasło konta nie powinno przechodzić przez urządzenie.
    saveLocalAdminPass("");
    saveConfiguration(newSSID, newPass, newEmail);
    client.println("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html><body style='background:#121212;color:#fff;font-family:sans-serif;text-align:center;padding:50px;'><h2>💾 Ustawienia Zapisane Pomyslnie!</h2></body></html>");
    delay(50); client.stop();
    ESP.restart();
    return;
  }

  client.println("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n");
  client.println("<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1.0'>");
  client.println("<style>body{background:#121212;color:#fff;font-family:sans-serif;padding:20px;} .box{background:#1e1e1e;padding:20px;border-radius:10px;max-width:400px;margin:20px auto;} input{display:block;width:92%;padding:12px;margin:12px auto;background:#2d2d2d;color:#fff;border:1px solid #444;border-radius:6px;}</style></head><body>");
  client.println("<h2 style='text-align:center;'>⚙ CTRLABLE Node Setup</h2><div class='box'><form method='GET' action='/save_setup'>");
  client.println("<input type='text' name='s' value='" + htmlEscape(String(ssid)) + "' placeholder='SSID Wi-Fi' maxlength='31' required>");
  client.println("<input type='password' id='wifi_pass' name='p' placeholder='Password' maxlength='31' required>");  // nigdy nie wypełniamy zapisanego hasła
  client.println("<label style='color:#aaa; font-size:14px; display:block; margin:-5px 0 15px 5px; cursor:pointer;'><input type='checkbox' onclick='togglePass()'> Pokaż hasło</label>");
  client.println("<script>function togglePass() { var x = document.getElementById('wifi_pass'); x.type = (x.type === 'password') ? 'text' : 'password'; }</script>");
  client.println("<input type='email' name='m' value='" + htmlEscape(String(owner_email)) + "' placeholder='Twój adres e-mail w aplikacji' maxlength='63' required>");
  client.println("<input type='submit' style='background:#5c33cf;font-weight:bold;cursor:pointer;' value='Save Infrastructure Settings'></form></div></body></html>");
  delay(50); client.stop();
}

// Lokalne API trybu offline. Uwierzytelnienie: pass=<hasło lokalne> (losowe,
// z konfiguracji offline). Bez hasła lokalnego (tryb online / pierwsza konfiguracja)
// żadna operacja nie przejdzie. Usunięte względem dawnej wersji: /api/update (wgrywanie
// firmware przez sieć lokalną — bez podpisu), /api/save_settings, UID kart i hasło
// administratora w /api/data.
void serveLocalApi(WiFiClient& client, const String& reqHeader) {
  blockTelemetry = true;

  if (failedLoginAttempts >= 5 && millis() < lockoutEndTime) {
    client.println("HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n[ALERT] LOCKOUT ACTIVE.");
    delay(1); client.stop(); blockTelemetry = false; return;
  }

  String attempted = queryParam(reqHeader, "pass");
  bool isAuthenticated = (localAdminPass[0] != 0) && secureEquals(attempted, localAdminPass);
  if (attempted.length() > 0) {
    if (!isAuthenticated) {
      failedLoginAttempts++;
      if (failedLoginAttempts >= 5) {
        lockoutEndTime = millis() + 300000;
        addLog("ALARM: Atak BruteForce!");
      }
    } else {
      failedLoginAttempts = 0;
    }
  }

  if (reqHeader.indexOf("GET /api/data") != -1) {
    client.println("HTTP/1.1 200 OK");
    client.println("Content-Type: application/json");
    client.println("Connection: close\r\n");
    if (!isAuthenticated) {
      client.println("{\"auth\":false}");
    } else {
      client.print("{\"auth\":true,\"mode\":\"");
      client.print(learningMode ? "Uczenie" : "Czuwanie");
      client.print("\",\"pending\":\""); client.print(pendingUsername);
      client.print("\",\"lock\":");
      client.print(doorOpen ? "true" : "false");
      client.print(",\"total\":"); client.print(totalCards);
      client.print(",\"version\":\""); client.print(app_version); client.print("\"");
      client.print(",\"users\":[");
      for (int i = 0; i < totalCards; i++) {
        client.print("{\"idx\":"); client.print(i);
        client.print(",\"name\":\""); client.print(users[i].name);
        client.print("\",\"active\":"); client.print(isCardActive[i] ? "true" : "false");
        client.print("}");   // UID celowo pominięty — jego znajomość wystarcza do skopiowania karty
        if (i < totalCards - 1) client.print(",");
      }
      client.print("],\"logs\":[");
      for (int i = logCount - 1; i >= 0; i--) {
        client.print("\"[" + lastActions[i].time + "] " + lastActions[i].msg + "\"");
        if (i > 0) client.print(",");
      }
      client.print("],\"ssid\":\""); client.print(ssid);
      client.print("\",\"tamper\":"); client.print(tamperActive ? "true" : "false");
      client.print("}");
    }
    delay(1); client.stop(); blockTelemetry = false; return;
  }

  if (!isAuthenticated) {
    client.println("HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nUnauthorized");
    delay(1); client.stop(); blockTelemetry = false; return;
  }

  if (reqHeader.indexOf("/api/unlock") != -1) {
    if (!doorOpen) openDoor("Panel API");
  }
  else if (reqHeader.indexOf("/api/toggle_learn") != -1) {
    learningMode = !learningMode;
    autoExitLearn = false;
    if (learningMode) {
      String u = queryParam(reqHeader, "username");
      u.replace("\"", ""); u.replace("\\", "");
      pendingUsername = u.length() > 0 ? u : "Nowy Uzytkownik";
      forceHardwareRFIDReset();
      globalAnimFrame = 0;
      addLog("Tryb Ucz. [" + pendingUsername + "]");
      playSound(SND_LEARN_ENTER);
    } else {
      addLog("Stop Ucz: Panel API");
      playSound(SND_LEARN_EXIT);
    }
  }
  else if (reqHeader.indexOf("/api/delete_user") != -1) {
    int targetIdx = queryParam(reqHeader, "idx").toInt();
    if (queryParam(reqHeader, "idx").length() > 0 && targetIdx >= 0 && targetIdx < totalCards) {
      String deletedName = String(users[targetIdx].name);
      deleteUser(targetIdx);
      addLog("Usunieto: " + deletedName);
      playSound(SND_DELETE);
    }
  }
  else if (reqHeader.indexOf("/api/rename_user") != -1) {
    int targetIdx = queryParam(reqHeader, "idx").toInt();
    String newName = queryParam(reqHeader, "name");
    newName.replace("\"", ""); newName.replace("\\", "");
    if (queryParam(reqHeader, "idx").length() > 0 && targetIdx >= 0 && targetIdx < totalCards && newName.length() > 0) {
      memset(users[targetIdx].name, 0, 16);
      newName.toCharArray(users[targetIdx].name, 16);
      persistCards();
      addLog("Zmiana nazwy slot [" + String(targetIdx) + "]");
      playSound(SND_CLICK_CONFIRM);
    }
  }
  else if (reqHeader.indexOf("/api/set_schedule") != -1) {
    int targetIdx = queryParam(reqHeader, "idx").length() ? queryParam(reqHeader, "idx").toInt() : -1;
    if (targetIdx >= 0 && targetIdx < totalCards) {
      int d = queryParam(reqHeader, "days").length() ? queryParam(reqHeader, "days").toInt() : 127;
      int s = queryParam(reqHeader, "start").toInt();
      int en = queryParam(reqHeader, "end").length() ? queryParam(reqHeader, "end").toInt() : 1440;
      cardSchEnabled[targetIdx] = queryParam(reqHeader, "en").toInt() ? 1 : 0;
      cardSchDays[targetIdx]  = (uint8_t)(d < 0 ? 127 : (d > 127 ? 127 : d));
      cardSchStart[targetIdx] = (uint16_t)(s < 0 ? 0 : (s > 1440 ? 1440 : s));
      cardSchEnd[targetIdx]   = (uint16_t)(en < 0 ? 0 : (en > 1440 ? 1440 : en));
      persistCards();
      addLog("Harmonogram slot [" + String(targetIdx) + "] " + (cardSchEnabled[targetIdx] ? "ON" : "OFF"));
    }
  }
  else if (reqHeader.indexOf("/api/toggle_user_active") != -1) {
    int targetIdx = queryParam(reqHeader, "idx").toInt();
    if (queryParam(reqHeader, "idx").length() > 0 && targetIdx >= 0 && targetIdx < totalCards) {
      isCardActive[targetIdx] = !isCardActive[targetIdx];
      persistCards();
      addLog(isCardActive[targetIdx] ? "Aktywowano: " + String(users[targetIdx].name) : "Zablokowano: " + String(users[targetIdx].name));
      playSound(SND_CLICK_CONFIRM);
    }
  }
  else if (reqHeader.indexOf("/api/clear_logs") != -1) {
    String cutoffVal = queryParam(reqHeader, "time");
    if (cutoffVal == "all") {
      logCount = 0;
      addLog("Wyczyszczono caly dziennik");
    } else if (cutoffVal.indexOf(":") != -1) {
      int targetMinutesWeight = cutoffVal.substring(0, cutoffVal.indexOf(":")).toInt() * 60 + cutoffVal.substring(cutoffVal.indexOf(":") + 1).toInt();
      int i = 0;
      while (i < logCount) {
        int logMinutesWeight = lastActions[i].time.substring(0, 2).toInt() * 60 + lastActions[i].time.substring(3, 5).toInt();
        if (logMinutesWeight < targetMinutesWeight) {
          for (int j = i; j < logCount - 1; j++) lastActions[j] = lastActions[j + 1];
          logCount--;
        } else {
          i++;
        }
      }
      addLog("Usunieto logi starsze niz " + cutoffVal);
    }
    playSound(SND_CLICK_CONFIRM);
  }
  else {
    client.println("HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nNot found");
    delay(1); client.stop(); blockTelemetry = false; return;
  }

  client.println("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nOK");
  delay(1); client.stop(); blockTelemetry = false;
}

void executeCloudSynchronization() { 
  WiFiClientSecure httpCheck; configureSecure(httpCheck);
  // TIMEOUTY: poll biegnie na RDZENIU 0 (networkTask) i NIGDY nie dotyka pętli, więc
  // może spokojnie czekać. Wcześniej były tu wartości ekstremalnie krótkie (connect 500 ms,
  // handshake 2 s, I/O 250 ms) z czasów, gdy poll blokował loop — i przez to KAŻDY poll
  // padał: handshake TLS z łańcuchem Let's Encrypt na ESP32 trwa realnie ~1,5–4 s.
  // Objaw: „[NET] Serwer nie odpowiada" w kółko + centralka nigdy nie rejestrowała się
  // na koncie (rejestracja dzieje się WYŁĄCZNIE przez poll). sendRemoteLog działał, bo
  // korzystał z hojnych wartości z configureSecure (handshake 6 s, I/O 6000 ms).
  httpCheck.setConnectionTimeout(4000);   // ms na TCP connect
  if (!httpCheck.connect(PROXMOX_SERVER, PROXMOX_PORT)) {
    Serial.println("[NET] Serwer Proxmox nie odpowiada. Ponowna proba...");
    if (pollFailStreak < 100) pollFailStreak++;
    return;
  }
  pollFailStreak = 0;

  lastSuccessfulPollTime = millis();
  String macStr = getMacAddressString();
  // &ip= — WŁASNY adres w sieci lokalnej. Serwer widzi tylko adres proxy (NPM), więc
  // bez tego zapisywał w bazie IP proxy i próbował na nie wysyłać zmiany nazwy,
  // harmonogramu i ustawień WiFi (syncMutationToHardware, port 80) — trafiając w pustkę.
  // ack= — najwyższy id komendy wykonanej przez loop (kolejka komend, README §7.3).
  unsigned long ackNow = cmdAckId;
  String pollPath = "/api/hardware/poll?version=" + urlEncode(String(app_version)) + "&mac=" + urlEncode(macStr) + "&opened=" + String(doorOpen ? "1" : "0") + "&email=" + urlEncode(String(owner_email)) + "&release_id=" + String(installedReleaseId) + "&ip=" + WiFi.localIP().toString() + "&ack=" + String(ackNow);
  httpCheck.println("GET " + pollPath + " HTTP/1.1");
  httpCheck.print("Host: "); httpCheck.println(PROXMOX_SERVER);
  printDeviceAuthHeader(httpCheck);
  httpCheck.println("Connection: close\r\n");  
  // ODCZYT: kończymy, gdy ciało JSON jest KOMPLETNE — nie czekamy, aż serwer zamknie
  // połączenie. Przy TLS connected() bywa prawdziwe jeszcze długo po odebraniu treści,
  // więc czekanie na zamknięcie zjadało cały deadline. Efekt był dotkliwy: poll trwał
  // kilka sekund zamiast ułamka, komenda odblokowania czekała na następny cykl
  // (timeout w aplikacji), a luki w heartbeacie wyglądały jak "centralka offline".
  unsigned long deadline = millis() + 4000;   // tylko bezpiecznik, normalnie wychodzimy wcześniej
  String payloadResponse = "";
  bool headersDone = false;
  int braceDepth = 0;
  bool bodyStarted = false;
  while ((httpCheck.available() || httpCheck.connected()) && millis() < deadline) {
    if (!httpCheck.available()) { vTaskDelay(pdMS_TO_TICKS(2)); continue; }
    char c = httpCheck.read();
    payloadResponse += c;
    if (!headersDone) {
      if (payloadResponse.endsWith("\r\n\r\n")) headersDone = true;
      continue;
    }
    if (c == '{') { braceDepth++; bodyStarted = true; }
    else if (c == '}') {
      braceDepth--;
      if (bodyStarted && braceDepth <= 0) break;   // pełny obiekt JSON — kończymy natychmiast
    }
  }
  httpCheck.stop();

  if (payloadResponse.startsWith("HTTP/1.1 401")) {
    // Serwer nie uznał klucza urządzenia (np. inna płytka pod tym MAC-iem albo klucz
    // zresetowany w NVS). Właściciel może zresetować przypięty klucz w aplikacji.
    if (millis() - lastAuthRejectLog > 600000 || lastAuthRejectLog == 0) {
      lastAuthRejectLog = millis();
      Serial.println("[SEC] Serwer odrzucil klucz urzadzenia (401).");
      addLog("Serwer odrzucil klucz urzadzenia");
    }
    return;
  }
  if (payloadResponse.startsWith("HTTP/1.1 200")) lastAckSent = ackNow;

  bool serverUnlockSignal = (payloadResponse.indexOf("\"unlock\":true") != -1);
  bool serverLearnSignal  = (payloadResponse.indexOf("\"learn\":true") != -1);
  bool serverOtaSignal    = (payloadResponse.indexOf("\"ota\":true") != -1);
  bool serverDeregisterSignal = (payloadResponse.indexOf("\"deregister\":true") != -1);
  
  int ridIdx = payloadResponse.indexOf("\"latest_release_id\":");
  if (ridIdx != -1) {
    ridIdx += 20;
    int ridEnd = payloadResponse.indexOf(",", ridIdx);
    if (ridEnd == -1) ridEnd = payloadResponse.indexOf("}", ridIdx);
    if (ridEnd > ridIdx) {
      unsigned long newReleaseId = payloadResponse.substring(ridIdx, ridEnd).toInt();
      if (newReleaseId > 0) latestFirmwareReleaseId = newReleaseId;
    }
  }

  // Konfigurowalne opoznienie auto-blokady - odczytywane z kazdej odpowiedzi
  // pollu, zeby zmiana w aplikacji dzialala natychmiast, bez restartu urzadzenia.
  // UWAGA na off-by-one: klucz "auto_lock_delay": ma 18 znaków, nie 19. Wcześniej
  // przesunięcie o 19 obcinało pierwszą cyfrę wartości (10000 -> "0000" = 0), więc
  // walidacja >=1000 odrzucała ją i rygiel zostawał na domyślnych 3 s. Błąd nie
  // ujawniał się, dopóki serwer w ogóle nie wysyłał tego pola. Liczymy długość klucza.
  static const char AUTO_LOCK_KEY[] = "\"auto_lock_delay\":";
  int autoLockIdx = payloadResponse.indexOf(AUTO_LOCK_KEY);
  if (autoLockIdx != -1) {
    autoLockIdx += (sizeof(AUTO_LOCK_KEY) - 1);
    int autoLockEnd = payloadResponse.indexOf(",", autoLockIdx);
    if (autoLockEnd == -1) autoLockEnd = payloadResponse.indexOf("}", autoLockIdx);
    if (autoLockEnd > autoLockIdx) {
      unsigned long newDelay = payloadResponse.substring(autoLockIdx, autoLockEnd).toInt();
      if (newDelay >= 1000 && newDelay <= 60000) autoLockDelayMs = newDelay;
    }
  }

  // Kolejka komend (zmiany kart, Wi-Fi). Porcję wykonuje loop — tu tylko odkładamy,
  // i tylko gdy poprzednia została już wykonana (inaczej zgubilibyśmy ją przy nadpisaniu).
  int cmdsIdx = payloadResponse.indexOf("\"cmds\":\"");
  if (cmdsIdx != -1 && !req_cmdsPending) {
    cmdsIdx += 8;
    int cmdsEnd = payloadResponse.indexOf("\"", cmdsIdx);
    if (cmdsEnd > cmdsIdx && (cmdsEnd - cmdsIdx) < (int)sizeof(req_cmds)) {
      payloadResponse.substring(cmdsIdx, cmdsEnd).toCharArray(req_cmds, sizeof(req_cmds));
      __sync_synchronize();          // bufor zapisany, zanim loop zobaczy flagę
      req_cmdsPending = true;
    }
  }

  // Deregistracja: właściciel trwale odłączył centralkę (potwierdzone kodem z maila).
  // Czyścimy CAŁY EEPROM (WiFi + owner_email + karty RFID) — firmware pozostaje nietknięty —
  // i restartujemy, przez co urządzenie wraca do trybu konfiguracji CTRLABLE_SETUP.
  // Task sieciowy (rdzeń 0) NIE dotyka sprzętu — ustawia flagi; akcje wykonuje loop (rdzeń 1).
  if (serverDeregisterSignal) {
    sendRemoteLog("[HARDWARE] Wykryto deregister:true — zlecam czyszczenie konfiguracji i restart.");
    req_deregister = true;
    return;
  }

  if (serverOtaSignal) {
    sendRemoteLog("[HARDWARE] Wykryto ota:true w pakiecie poll! Zlecam update.");
    req_ota = true;
    return;
  }

  if (serverUnlockSignal) {
    req_unlock = true;   // loop sprawdzi tamper i otworzy
  }

  if (serverLearnSignal) {
    learningMode = true;
    int userStart = payloadResponse.indexOf("\"username\":\"");
    int userEnd = payloadResponse.indexOf("\"", userStart + 12);
    if (userStart > -1 && userEnd > userStart) {
      payloadResponse.substring(userStart + 12, userEnd).toCharArray(req_username, sizeof(req_username));
      req_usernameUpdated = true;
    }
  } else {
    learningMode = false;
  }
}

void performLocalFirmwareUpdate() {
  WiFiClientSecure otaClient; configureSecure(otaClient);
  updateDisplay("AKTUALIZACJA OTA", "Pobieranie pliku...");
  sendRemoteLog("[OTA PULL] Proba polaczenia z serwerem w celu pobrania binu...");
  
  if (otaClient.connect(PROXMOX_SERVER, PROXMOX_PORT)) {
    otaClient.setTimeout(5000);
    String macStr = getMacAddressString();
    otaClient.print("GET /api/lock/download-firmware?mac=" + urlEncode(macStr) + " HTTP/1.1\r\n");
    otaClient.print("Host: " + String(PROXMOX_SERVER) + "\r\n");
    printDeviceAuthHeader(otaClient);
    otaClient.print("Connection: close\r\n\r\n");

    unsigned long contentLength = 0;
    int httpStatus = 0;
    String firmwareSig = "";   // podpis ECDSA obrazu (base64) — bez niego nic nie instalujemy
    while (otaClient.connected()) {
      String line = otaClient.readStringUntil('\n');
      if (httpStatus == 0 && line.startsWith("HTTP/1.")) httpStatus = line.substring(9, 12).toInt();
      String lower = line; lower.toLowerCase();
      if (lower.startsWith("content-length:")) {
        contentLength = line.substring(line.indexOf(":") + 1).toInt();
      }
      if (lower.startsWith("x-firmware-signature:")) {
        firmwareSig = line.substring(line.indexOf(":") + 1);
        firmwareSig.trim();
      }
      if (line == "\r" || line == "\r\n" || line.length() == 0) {
        break;
      }
    }
    if (httpStatus != 200 || firmwareSig.length() == 0) {
      updateDisplay("BŁĄD OTA", "Brak podpisu/zgody");
      addLog("[OTA PULL ERR] Serwer odmowil (HTTP " + String(httpStatus) + ") albo brak podpisu obrazu. Przerywam.");
      otaClient.stop();
      delay(3000);
      return;
    }
    
    addLog("[OTA PULL] Naglowki przeczytane. Content-Length: " + String(contentLength));  // addLog (bez TLS) — w trakcie OTA nie otwieramy 2. polaczenia TLS (OOM)
    if (contentLength == 0) {
      updateDisplay("BŁĄD OTA", "Brak rozmiaru naglowka");
      addLog("[OTA PULL ERR] Serwer zwrocil rozmiar 0. Przerywam.");
      otaClient.stop();
      delay(3000);
      return;
    }
    
    if (Update.begin(contentLength, U_FLASH)) {
      addLog("[OTA PULL] Start szybkiej transmisji blokowej...");
      // SHA-256 liczony w locie z tych samych bajtów, które idą do flasha.
      mbedtls_sha256_context shaCtx;
      mbedtls_sha256_init(&shaCtx);
      mbedtls_sha256_starts(&shaCtx, 0);
      uint32_t receivedBytes = 0;
      unsigned long receiveDeadline = millis() + 10000; 
      
      uint8_t buffer[256];
      
      // PANCERNA PĘTLA: Czytamy dopóki nie zbierzemy wszystkich bajtów zadeklarowanych w Content-Length
      while (receivedBytes < contentLength) { 
        if (!otaClient.connected() && !otaClient.available()) {
          addLog("[OTA PULL ERR] Polaczenie zerwane przed pobraniem calosci.");
          break;
        }

        int availableBytes = otaClient.available();
        if (availableBytes > 0) {
          int toRead = min(availableBytes, (int)sizeof(buffer));
          if (receivedBytes + toRead > contentLength) {
            toRead = contentLength - receivedBytes;
          }
          
          int readBytes = otaClient.read(buffer, toRead);
          if (readBytes > 0) {
            if (Update.write(buffer, readBytes) == readBytes) {
              mbedtls_sha256_update(&shaCtx, buffer, readBytes);
              receivedBytes += readBytes;
              receiveDeadline = millis() + 10000; 
            } else {
              addLog("[OTA PULL ERR] Blad zapisu w pamieci Flash.");
              break;
            }
          }
        } 
        
        if (millis() > receiveDeadline) {
          addLog("[OTA PULL ERR] Timeout transmisji.");
          break;
        }
        delay(1);
      } 
      
      otaClient.stop();
      uint8_t fwHash[32];
      mbedtls_sha256_finish(&shaCtx, fwHash);
      mbedtls_sha256_free(&shaCtx);
      sendRemoteLog("[OTA PULL] Zakonczono pobieranie. Odebrano: " + String(receivedBytes) + "/" + String(contentLength));
      // PODPIS: obraz niepodpisany kluczem producenta NIE zostanie aktywowany, nawet jeśli
      // przyszedł z „naszego" serwera — chroni przed przejęciem serwera lub konta GitHub.
      if (receivedBytes == contentLength && !verifyFirmwareSignature(fwHash, firmwareSig)) {
        Update.abort();
        updateDisplay("BŁĄD OTA", "Zly podpis obrazu");
        sendRemoteLog("[OTA PULL ERR] Podpis firmware NIEPRAWIDLOWY - aktualizacja odrzucona.");
        delay(3000);
        return;
      }
      if (receivedBytes == contentLength && Update.end(true)) { 
        if (Update.isFinished()) {
          updateDisplay("SUKCES OTA", "Wgrywanie i Reset...");
          sendRemoteLog("[OTA PULL SUCCESS] Aktualizacja kompletna i zweryfikowana! Restart systemu...");
          delay(2000);
          EEPROM.put(480, latestFirmwareReleaseId);
          EEPROM.commit();
          ESP.restart();
        }
      } else {
        updateDisplay("BŁĄD OTA", "Blad sumy bajtow");
        sendRemoteLog("[OTA PULL ERR] Blad weryfikacji pliku binarnie lub przerwany stream. Error: " + String(Update.errorString()));
        Update.abort();
        delay(3000);
      }
    } else {
      updateDisplay("BŁĄD OTA", "Brak miejsca flash");
      addLog("[OTA PULL ERR] Brak wolnego miejsca na partycji OTA (begin failed).");
      delay(3000);
    }
  } else {
    updateDisplay("BŁĄD OTA", "Brak linku z nodem");
    sendRemoteLog("[OTA PULL ERR] Nie udalo sie polaczyc z serwerem Proxmox pod " + String(PROXMOX_SERVER));
    delay(3000);
  }
}

// UWAGA: wołać WYŁĄCZNIE z networkTask (rdzeń 0) — blokuje na czas handshake'u TLS.
// Dane wejściowe przychodzą z kolejki (up_*), a nie ze stanu pętli, żeby rdzeń 0
// nie czytał zmiennych, które w tym czasie może zmieniać rdzeń 1.
void transmitCardPayloadToCloud(String uidStr, String nameStr, int slot, bool runRegister) {
  WiFiClientSecure httpPost; configureSecure(httpPost);
  if (!httpPost.connect(PROXMOX_SERVER, PROXMOX_PORT)) return;
  String endpoint = runRegister ? "/api/hardware/register" : "/api/hardware/scan";
  String macStr = getMacAddressString();
  String postData = runRegister ?
    "{\"mac\":\"" + macStr + "\",\"uid\":\"" + uidStr + "\",\"name\":\"" + nameStr + "\",\"slot\":" + String(slot) + "}" :
    "{\"mac\":\"" + macStr + "\",\"uid\":\"" + uidStr + "\"}";
  httpPost.println("POST " + endpoint + " HTTP/1.1"); 
  httpPost.print("Host: "); httpPost.println(PROXMOX_SERVER);
  printDeviceAuthHeader(httpPost);
  httpPost.println("Content-Type: application/json"); 
  httpPost.print("Content-Length: "); httpPost.println(postData.length()); 
  httpPost.println("Connection: close\r\n"); 
  httpPost.print(postData);
  // Odpowiedź nas nie interesuje (i tak była wyrzucana) — czekanie na zamknięcie
  // połączenia tylko opóźniało kolejny poll, czyli raportowanie stanu rygla.
  // Wystarczy dać żądaniu dojść do serwera i zamknąć gniazdo.
  unsigned long deadline = millis() + 600;
  while (!httpPost.available() && httpPost.connected() && millis() < deadline) {
    vTaskDelay(pdMS_TO_TICKS(10));
  }
  httpPost.stop();
} 


// =========================================================================
// ANTI-TAMPER — sendTamperAlert() + checkTamper()
// =========================================================================
void sendTamperAlert(bool active) {
  if (WiFi.status() != WL_CONNECTED) return;
  WiFiClientSecure tc; configureSecure(tc);
  tc.setConnectionTimeout(500);
  if (!tc.connect(PROXMOX_SERVER, PROXMOX_PORT)) return;
  String mac  = getMacAddressString();
  String body = "{\"mac\":\"" + mac + "\",\"active\":" + (active ? "true" : "false") + "}";
  tc.println("POST /api/tamper HTTP/1.1");
  tc.print("Host: "); tc.println(PROXMOX_SERVER);
  printDeviceAuthHeader(tc);
  tc.println("Content-Type: application/json");
  tc.print("Content-Length: "); tc.println(body.length());
  tc.println("Connection: close\r\n"); tc.print(body);
  unsigned long t = millis();
  while ((tc.connected() || tc.available()) && millis()-t < 500) { if (tc.available()) tc.read(); }
  tc.stop();
}

void checkTamper() {
  if (!TAMPER_INSTALLED) return;    // wyłączone do czasu fizycznej instalacji przełącznika
  if (WiFi.status() != WL_CONNECTED) return;
  bool currentlyOpen = (digitalRead(TAMPER_PIN) == HIGH);
  if (currentlyOpen && !tamperActive) {
    tamperActive = true;
    addLog("!! TAMPER: obudowa drugiej plytki otwarta !!");
    playSound(SND_TAMPER_ALARM);
    digitalWrite(LED_GREEN, LOW); digitalWrite(LED_RED, HIGH);
    sendTamperAlert(true); lastTamperPost = millis();
  } else if (!currentlyOpen && tamperActive) {
    tamperActive = false;
    addLog("TAMPER CLEARED: obudowa zamknieta");
    digitalWrite(LED_RED, LOW);
    sendTamperAlert(false);
  } else if (tamperActive && (millis() - lastTamperPost >= TAMPER_REPEAT_MS)) {
    playSound(SND_TAMPER_ALARM);
    sendTamperAlert(true); lastTamperPost = millis();
  }
}

// =========================================================================
// KLAWIATURA PIN — 4×3 matrix keypad
// =========================================================================
char scanKeypad() {
  for (int c = 0; c < 3; c++) {
    digitalWrite(KP_COLS[c], LOW);
    delayMicroseconds(50);
    for (int r = 0; r < 4; r++) {
      if (digitalRead(KP_ROWS[r]) == LOW) {
        digitalWrite(KP_COLS[c], HIGH);
        return KP_MAP[r][c];
      }
    }
    digitalWrite(KP_COLS[c], HIGH);
  }
  return 0;
}

void verifyKeypadPIN(const String& pin) {
  kpChecking = true; renderSystemUI();
  if (WiFi.status() != WL_CONNECTED) {
    logKeypadEvent("Keypad: offline - brak weryfikacji PIN"); playSound(SND_ACCESS_DENIED);
    kpChecking = false; renderSystemUI(); return;
  }
  if (tamperActive) {
    logKeypadEvent("Keypad: BLOKADA - aktywny alarm sabotazu"); playSound(SND_ACCESS_DENIED);
    kpChecking = false; renderSystemUI(); return;
  }
  WiFiClientSecure kc; configureSecure(kc);
  kc.setConnectionTimeout(2000);
  if (!kc.connect(PROXMOX_SERVER, PROXMOX_PORT)) {
    logKeypadEvent("Keypad: blad polaczenia z serwerem"); playSound(SND_ACCESS_DENIED);
    kpChecking = false; renderSystemUI(); return;
  }
  String mac  = getMacAddressString();
  String body = "{\"mac\":\"" + mac + "\",\"pin\":\"" + pin + "\"}";
  kc.println("POST /api/auth/keypad HTTP/1.1");
  kc.print("Host: "); kc.println(PROXMOX_SERVER);
  printDeviceAuthHeader(kc);
  kc.println("Content-Type: application/json");
  kc.print("Content-Length: "); kc.println(body.length());
  kc.println("Connection: close\r\n"); kc.print(body);
  unsigned long deadline = millis() + 3000; String resp = "";
  while ((kc.connected() || kc.available()) && millis() < deadline) { if (kc.available()) resp += (char)kc.read(); }
  kc.stop();
  if (resp.indexOf("\"granted\":true") != -1) {
    // Extract the PIN owner's name from the server response
    String pinOwner = "Keypad PIN";
    int ns = resp.indexOf("\"name\":\"");
    if (ns != -1) {
      ns += 8;
      int ne = resp.indexOf("\"", ns);
      if (ne > ns) pinOwner = resp.substring(ns, ne);
    }
    logKeypadEvent("Keypad: ZAAKCEPTOWANO [" + pinOwner + "] - otwieranie");
    playSound(SND_ACCESS_GRANTED);
    if (!doorOpen) openDoor("Keypad: " + pinOwner);
  } else {
    logKeypadEvent("Keypad: PIN ODRZUCONY");
    playSound(SND_ACCESS_DENIED);
    for (int i = 0; i < 2; i++) { digitalWrite(LED_RED, HIGH); delay(120); digitalWrite(LED_RED, LOW); delay(80); }
  }
  kpChecking = false; renderSystemUI();
}

void handleKeypress(char key) {
  // (Usunięto log diagnostyczny każdego klawisza — zapisywał do dziennika cyfry PIN-u.)
  kpLastKey = millis();
  if (key == '#') {
    playSound(SND_KEY_SUBMIT);
    if (kpBuffer.length() == 0) return;
    if ((int)kpBuffer.length() < 4) {
      logKeypadEvent("Keypad: PIN za krotki (min 4 cyfry)"); playSound(SND_ACCESS_DENIED);
      kpBuffer = ""; renderSystemUI(); return;
    }
    String pin = kpBuffer; kpBuffer = ""; verifyKeypadPIN(pin);
  } else if (key == '*') {
    playSound(SND_KEY_CLEAR);
    logKeypadEvent("Keypad: * czyszczenie bufora");
    kpBuffer = ""; renderSystemUI();
  } else {
    playSound(SND_KEY_DIGIT);
    if ((int)kpBuffer.length() < KP_MAX_LEN) {
      kpBuffer += key;
      renderSystemUI();
    }
  }
}

void checkKeypad() {
  if (!KEYPAD_INSTALLED) return;  // wyłączone do czasu fizycznego podłączenia klawiatury
  if (kpBuffer.length() > 0 && (millis() - kpLastKey > KP_TIMEOUT_MS)) {
    kpBuffer = ""; kpLastChar = 0; renderSystemUI();
    logKeypadEvent("Keypad: timeout - bufor wyczyszczony");
  }
  char key = scanKeypad();
  if (key == 0) { kpLastChar = 0; return; }
  if (key == kpLastChar && (millis() - kpLastPress < KP_DEBOUNCE_MS)) return;
  kpLastChar = key; kpLastPress = millis();
  handleKeypress(key);
}

void setup() {
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);  // natychmiastowy stan LOW (spoczynek/nieenergizowana) -- zablokowane od startu
  pinMode(LED_GREEN, OUTPUT); 
  Serial.begin(9600); 
  delay(1500);
  EEPROM.begin(512);
  // Radio włączone PRZED losowaniem sekretów: dopiero wtedy esp_random() korzysta ze
  // sprzętowego źródła entropii (bez RF to generator pseudolosowy).
  WiFi.mode(WIFI_STA);
  loadOrCreateDeviceSecrets();
  loadLocalAdminPass();
  EEPROM.get(480, installedReleaseId);  // restore flashed release ID
  // Sanityzacja: świeży/wyczyszczony EEPROM to same 0xFF → 4294967295, czyli numer
  // większy od każdego realnego release'u z GitHuba. Traktujemy to jako "nieznany" (0),
  // żeby serwer znów widział dostępne aktualizacje. Naprawia też urządzenia
  // wyczyszczone STARYM firmwarem, bez potrzeby kolejnego resetu.
  if (installedReleaseId == 0xFFFFFFFFUL || installedReleaseId > 4000000000UL) {
    installedReleaseId = 0;
    EEPROM.put(480, (unsigned long)0);
    EEPROM.commit();
  }
  initStorage();                        // LittleFS (etap 1a) — montowanie + self-test na Serialu
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(RESET_BTN_PIN, INPUT);  // GPIO39 input-only, pull-up ZEWNĘTRZNY (10kΩ do 3.3V)
  // Anti-tamper pin (tylko gdy TAMPER_INSTALLED == true)
  if (TAMPER_INSTALLED) pinMode(TAMPER_PIN, INPUT_PULLUP);
  // Klawiatura — tylko gdy KEYPAD_INSTALLED == true
  // Bez flagi: IO2 nie jest ustawiany jako OUTPUT (nie zapala się niebieska LED),
  //            IO34/IO35 nie są inicjowane (nie pływają, brak fałszywych wciśnięć)
  if (KEYPAD_INSTALLED) {
    for (int c = 0; c < 3; c++) { pinMode(KP_COLS[c], OUTPUT); digitalWrite(KP_COLS[c], HIGH); }
    pinMode(KP_ROW1, INPUT_PULLUP);  // IO14 — wewnętrzny pull-up, brak diody LED
    pinMode(KP_ROW2, INPUT_PULLUP);  // IO15
    pinMode(KP_ROW3, INPUT_PULLUP);  // IO34 — internal pull-up
    pinMode(KP_ROW4, INPUT_PULLUP);  // IO35 — internal pull-up
    delay(50);
  }
  Wire.begin();
  Wire.setClock(400000);   // I2C 400 kHz zamiast domyślnych 100 kHz — pełny render OLED
                           // ~4× szybszy (~25 ms zamiast ~90 ms), pętla nie siada do 40/s
  Wire.beginTransmission(0x3C);
  if (Wire.endTransmission() == 0) {
    display.begin(0x3C, true);
    display.clearDisplay();
    oledConnected = true;
    Serial.println("[DISPLAY] Ekran OLED wykryty i zainicjalizowany.");
  } else {
    oledConnected = false;
    Serial.println("[WARN] Brak ekranu OLED. Ekran wyłączony bezpiecznie.");
  }

  // Relay idle: OUTPUT LOW → pull-down dominates → IN ~0V → NPN OFF → relay releases
  relayDeactivate();
  
  pinMode(LED_GREEN, OUTPUT); 
  pinMode(LED_RED, OUTPUT); 
  pinMode(RST_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT); 
  digitalWrite(RST_PIN, HIGH); 
  delay(50);
  
  digitalWrite(LED_GREEN, LOW); 
  digitalWrite(LED_RED, LOW); 

  SPI.begin(); 
  rfid.PCD_Init();

  // 5. Ładowanie konfiguracji z pamięci
  loadConfiguration(); 
  loadCards();

  // Obsługa dedykowanego przycisku Factory Reset przy starcie (RESET_BTN_PIN)
  if (digitalRead(RESET_BTN_PIN) == LOW) {
    delay(2000);
    if (digitalRead(RESET_BTN_PIN) == LOW) {
      factoryResetSettings();
      Serial.println("[FACTORY RESET COMPLETE]");
      // Twardy powrót do zera: config i karty są już w RAM (wczytane wyżej),
      // więc bez restartu urządzenie chodziłoby dalej na STARYCH danych do
      // najbliższego wyłączenia. Restartujemy od razu — po restarcie EEPROM
      // jest pusty → loadConfiguration() wejdzie w CTRLABLE_SETUP.
      updateDisplay("FACTORY RESET", "Kasowanie...\nRestart");
      playSound(SND_PROVISION_START);
      delay(1500);
      ESP.restart();
    }
  }
  
  randomSeed(analogRead(0)); 
  delay(300); 

  // 6. Bezpieczne wejście w tryb konfiguracji (ekran i RFID już działają)
  if (provisioningMode) { 
    displayProvisioningInstructions(""); 
    startSetupAP();   // WPA2, hasło na ekranie (tylko w tym trybie)
    server.begin();
    playSound(SND_PROVISION_START);
    unsigned long lastSetupTick = 0;
    bool alternateState = false;
    while (true) {
      handleLocalHttp();
      updateBuzzer();
      if (millis() - lastSetupTick > 400) { 
        lastSetupTick = millis(); 
        globalAnimFrame++; 
        renderSystemUI();
        alternateState = !alternateState; 
        digitalWrite(LED_RED, alternateState ? HIGH : LOW); 
        digitalWrite(LED_GREEN, alternateState ? LOW : HIGH);
      } 
      delay(10); 
    } 
  } 

  // Konfiguracja połączenia z Twoją siecią docelową
  if (String(ssid) == "OFFLINE_MODE") {
    // 🌟 Urządzenie zostało jawnie skonfigurowane jako w pełni lokalne/offline -
    // próba WiFi.begin() do tego SSID z definicji nigdy się nie powiedzie, więc
    // nie czekamy bezsensownie 12 sekund przy KAŻDYM uruchomieniu. Przechodzimy
    // od razu do trybu lokalnego (RFID + przycisk + panel lokalny na AP).
    isOfflineStandby = true;
    forceHardwareRFIDReset();
    displayProvisioningInstructions("TRYB OFFLINE AKTYWNY");
    startSetupAP();
    server.begin();
    playSound(SND_PROVISION_START);
    lastWifiRetryTime = millis();
  } else {
    updateDisplay("Wi-Fi: Laczenie...", "Proba: 1/3 [....]");
    WiFi.begin(ssid, pass); 
    unsigned long startAttempt = millis(); 
    int counter = 0;
    while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 12000) { 
      delay(500); 
      counter++;
      if (counter == 8) updateDisplay("Wi-Fi: Laczenie...", "Proba: 2/3 [======]"); 
      if (counter == 16) updateDisplay("Wi-Fi: Laczenie...", "Proba: 3/3 [........]");
    } 

    if (WiFi.status() == WL_CONNECTED) { 
      timeClient.begin(); 
      timeClient.update(); 
      unsigned long epochTime = timeClient.getEpochTime();
      struct timeval tv = { .tv_sec = (time_t)epochTime, .tv_usec = 0 };
      settimeofday(&tv, NULL); 
      forceHardwareRFIDReset(); 
      lastSuccessfulPollTime = millis();
      // Tryb online: centralka NIE wystawia żadnego portu w sieci domowej (README §7.1).
      // Zarządzanie wyłącznie przez serwer (TLS + klucz urządzenia).
      updateDisplay("Gotowy", WiFi.localIP().toString()); 
      addLog("System online"); 
      playSound(SND_WIFI_CONNECTED);
    } else { 
      isOfflineStandby = true; 
      forceHardwareRFIDReset();
      displayProvisioningInstructions("ERR: CONN TIMEOUT"); 
      WiFi.disconnect();
      delay(500);
      startSetupAP();   // awaryjny AP — za hasłem WPA2 (dawniej otwarty dla każdego w zasięgu)
      server.begin();
      playSound(SND_WIFI_FAILED);
      lastWifiRetryTime = millis(); 
    } 
  }
  lastRfidWatchdogTime = millis();
  lastFrameTick = millis();

  // ── Boot signature: 3 quick beeps = firmware v3 with keypad+tamper loaded ──
  // If you do NOT hear 3 beeps at the end of boot, the old firmware is still running.
  tone(BUZZER_PIN, 1800, 80); delay(150);
  tone(BUZZER_PIN, 1800, 80); delay(150);
  tone(BUZZER_PIN, 1800, 80); delay(150);

  // ── Late keypad diagnostics — printed AFTER WiFi (Serial Monitor definitely open) ──
  if (KEYPAD_INSTALLED) {
    delay(200);
    Serial.println("\n======= KEYPAD ROW DIAGNOSTICS =======");
    Serial.println("All rows must read HIGH when no key pressed.");
    Serial.println("LOW = pull-up resistor missing, wrong direction, or wrong pin.");
    Serial.print("ROW1 IO"); Serial.print(KP_ROW1); Serial.print(": ");
    Serial.println(digitalRead(KP_ROW1) ? "HIGH - OK" : "LOW  - PROBLEM (internal pull-up issue)");
    Serial.print("ROW2 IO"); Serial.print(KP_ROW2); Serial.print(": ");
    Serial.println(digitalRead(KP_ROW2) ? "HIGH - OK" : "LOW  - PROBLEM (internal pull-up issue)");
    Serial.print("ROW3 IO"); Serial.print(KP_ROW3); Serial.print(": ");
    Serial.println(digitalRead(KP_ROW3) ? "HIGH - OK" : "LOW  - PROBLEM (10k to 3.3V missing or wired to GND)");
    Serial.print("ROW4 IO"); Serial.print(KP_ROW4); Serial.print(": ");
    Serial.println(digitalRead(KP_ROW4) ? "HIGH - OK" : "LOW  - PROBLEM (10k to 3.3V missing or wired to GND)");
    Serial.println("======================================\n");
  }

  // Start taska SIECIOWEGO na rdzeniu 0. Cały sprzęt (RFID/przekaźnik/dźwięk/OLED)
  // zostaje na rdzeniu 1 (loop). Stos 12 KB — TLS/mbedTLS + String są pamięciożerne.
  xTaskCreatePinnedToCore(networkTask, "netTask", 12288, NULL, 1, &networkTaskHandle, 0);
}

// Task SIECIOWY — rdzeń 0. Poll (blokujący TLS) + logi zdarzeń, NIE dotyka sprzętu.
// Handshake TLS nigdy nie zamraża pętli (rdzeń 1) → karta czyta się natychmiast
// (lokalny match), niezależnie od stanu sieci. Pauzuje na czas OTA/deregister.
void networkTask(void *param) {
  for (;;) {
    if (WiFi.status() == WL_CONNECTED && !isOfflineStandby && !req_ota && !req_deregister) {
      if (!fsStatusReported) {
        fsStatusReported = true;
        sendRemoteLog("[FS] LittleFS " + String(fsMounted ? "OK" : "BLAD MONTAZU") +
                      " total=" + String(fsTotalBytes) + "B used=" + String(fsUsedBytes) +
                      "B FsCard=" + String(sizeof(FsCard)) + "B FsPin=" + String(sizeof(FsPin)) +
                      "B selftest=" + String(fsSelfTestPass ? "PASS" : "FAIL"));
      }
      // KOLEJNOŚĆ MA ZNACZENIE: najpierw POLL (niesie stan rygla „opened"), dopiero
      // potem zgłoszenia „nice to have". Każde z nich to osobny handshake TLS (~2 s),
      // więc gdy szły pierwsze, informacja o otwarciu docierała do serwera dopiero
      // po ~4 s — czyli już PO automatycznym zamknięciu (3 s) i aplikacja pokazywała
      // „Otwarto" po fakcie.
      unsigned long pollInterval = (pollFailStreak >= 3) ? 8000UL : 1000UL;   // backoff gdy serwer nieosiągalny
      if (forceSyncNow || millis() - lastPollTime > pollInterval) {
        executeCloudSynchronization();
        lastPollTime = millis();
        forceSyncNow = false;
        // Nowa sieć Wi-Fi zapisana z komendy serwera — restart dopiero, gdy serwer
        // potwierdził odbiór ack (inaczej komenda wracałaby po każdym starcie).
        if (restartAfterAckId > 0 && lastAckSent >= restartAfterAckId) {
          Serial.println("[CMD] Nowa siec Wi-Fi potwierdzona - restart.");
          vTaskDelay(pdMS_TO_TICKS(300));
          ESP.restart();
        }
      }

      // Zgłoszenie skanu karty (zakolejkowane przez loop) — TLS robimy TU, nie w pętli.
      if (req_cardUpload) {
        transmitCardPayloadToCloud(String(up_uid), String(up_name), up_slot, up_register);
        req_cardUpload = false;
        forceSyncNow = true;   // po rejestracji karty odśwież stan od razu
      }

      // Raport diagnostyczny / self-test zbudowany przez loop — wysyłamy tu (TLS).
      if (req_diagReport) {
        __sync_synchronize();
        sendDiagnosticReport();
        req_diagReport = false;
      }

      // Log przycisku (zakolejkowany przez loop) — nieblokujący dla rdzenia 1.
      if (req_buttonLog) {
        req_buttonLog = false;
        WiFiClientSecure btnLog; configureSecure(btnLog);
        btnLog.setConnectionTimeout(3000);
        if (btnLog.connect(PROXMOX_SERVER, PROXMOX_PORT)) {
          btnLog.println("GET /api/hardware/log_button?mac=" + urlEncode(getMacAddressString()) + " HTTP/1.1");
          btnLog.print("Host: "); btnLog.println(PROXMOX_SERVER);
          printDeviceAuthHeader(btnLog);
          btnLog.println("Connection: close\r\n");
          delay(50);
          btnLog.stop();
        }
      }
    }
    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

void loop() {
  updateBuzzer(); // serwisuje aktualnie odtwarzaną melodię - zero delay(), zero blokowania
  // Lokalny serwer HTTP obsługujemy wyłącznie w trybie AP (patrz koniec loop()).
  // Dawniej działał „też gdy online" i przyjmował /save_setup bez żadnego hasła.

  // Komendy z taska sieciowego (rdzeń 0) — akcje SPRZĘTOWE wykonujemy TU (rdzeń 1).
  if (req_usernameUpdated) { req_usernameUpdated = false; pendingUsername = String(req_username); }
  if (req_deregister) {
    req_deregister = false;
    updateDisplay("ODLACZANIE", "Reset ustawien...");
    factoryResetSettings(); delay(800); ESP.restart();
  }
  if (req_ota) { req_ota = false; performLocalFirmwareUpdate(); }
  if (req_unlock) {
    req_unlock = false;
    if (tamperActive) { addLog("!! BLOKADA: zdalne otwarcie (alarm sabotazu)!"); sendTamperAlert(true); }
    else if (!doorOpen) openDoor("Otwarte");
  }
  applyPendingCommands();   // zmiany kart / Wi-Fi odebrane z serwera
  checkTamper();  // anti-tamper (brak efektu gdy TAMPER_INSTALLED == false)
  checkKeypad();  // obsługa matrycy klawiatury PIN

  if (millis() - lastFrameTick > 150) {   // było 80 ms — rzadszy render OLED = mniej dławienia pętli/skanu RFID
    lastFrameTick = millis();
    globalAnimFrame++;
    renderSystemUI();
  }

  if (!doorOpen && !learningMode && (millis() - lastRfidWatchdogTime > 120000)) { 
    lastRfidWatchdogTime = millis();
    forceHardwareRFIDReset(); 
  } 

  if (isOfflineStandby) {
    // Retry WiFi zawsze, gdy jest zapisana realna konfiguracja (nie tylko gdy centralka
    // BYŁA wcześniej online). Naprawia utknięcie w AP po zaniku prądu, gdy router wstaje
    // wolniej niż centralka: przy starcie WiFi nie zdąży (12 s), a bez tego warunku
    // rescue-watchdog nigdy nie ruszał (systemWasOnline == false) i AP zostawał na stałe.
    if (!provisioningMode && String(ssid) != "OFFLINE_MODE" && (millis() - lastWifiRetryTime > 60000)) {
      lastWifiRetryTime = millis();
      updateDisplay("RESCUE WATCHDOG", "Sprawdzam Wi-Fi...");
      WiFi.begin(ssid, pass); 
      unsigned long checkStart = millis();
      while (WiFi.status() != WL_CONNECTED && millis() - checkStart < 6000) { 
        delay(200);
      } 
      
      if (WiFi.status() == WL_CONNECTED) { 
        isOfflineStandby = false;
        timeClient.begin(); 
        timeClient.update(); 
        unsigned long epochTime = timeClient.getEpochTime(); 
        struct timeval tv = { .tv_sec = (time_t)epochTime, .tv_usec = 0 };
        settimeofday(&tv, NULL);
        server.end();     // z powrotem online — koniec nasłuchu (README §7.1)
        WiFi.softAPdisconnect(true);
        updateDisplay("Gotowy", WiFi.localIP().toString()); 
        addLog("Polaczenie Wi-Fi przywrocone"); 
        lastSuccessfulPollTime = millis();
        playSound(SND_WIFI_RESTORED);
      } else { 
        WiFi.disconnect(); 
        delay(1000);
        startSetupAP();
        delay(500);
        server.begin(); 
        displayProvisioningInstructions("ERR: REKONEKCJA FAIL");
      } 
    } 
  } 

  if (rfidResetPending && !doorOpen && (millis() - lastScanTime > 1000)) { 
    forceHardwareRFIDReset();
    rfidResetPending = false; 
    if (learningMode) { 
      globalAnimFrame = 0;
    } else { 
      globalDisplayInfo = "";
    } 
  } 

  if (learningMode) { 
    if (millis() % 500 < 250) { 
      digitalWrite(LED_RED, HIGH);
      digitalWrite(LED_GREEN, LOW); 
    } else { 
      digitalWrite(LED_RED, LOW); 
      digitalWrite(LED_GREEN, HIGH);
    } 
  } else if (!doorOpen) { 
    if (failedLoginAttempts >= 5 && millis() < lockoutEndTime) { 
      digitalWrite(LED_RED, millis() % 200 < 100 ? HIGH : LOW);
      digitalWrite(LED_GREEN, LOW); 
    } else { 
      if (isOfflineStandby) { 
        digitalWrite(LED_RED, millis() % 1000 < 150 ? LOW : HIGH);
      } else { 
        digitalWrite(LED_RED, LOW);
      } 
      digitalWrite(LED_GREEN, LOW); 
    } 
  } 

  if (!rfidResetPending && !doorOpen && (failedLoginAttempts < 5 || millis() > lockoutEndTime) && rfid.PICC_IsNewCardPresent()) { 
    delay(20);
    if (rfid.PICC_ReadCardSerial()) { 
      lastRfidWatchdogTime = millis(); 
      String uidStr = "";
      for (byte i = 0; i < rfid.uid.size; i++) { 
        if (rfid.uid.uidByte[i] < 0x10) uidStr += "0";
        uidStr += String(rfid.uid.uidByte[i], HEX); 
        if (i < rfid.uid.size - 1) uidStr += " ";
      } 
      uidStr.toUpperCase(); 
      // Zgłoszenie do chmury NIE blokuje już pętli: odkładamy je do kolejki, a pełny
      // handshake TLS wykona networkTask na rdzeniu 0. Kolejkujemy PO ewentualnym
      // zapisie karty (niżej), żeby wysłać właściwy numer slotu.
      bool wasLearning = learningMode;
      int savedSlot = -1;
      if (learningMode) {
        savedSlot = saveNewCard(rfid.uid.uidByte, pendingUsername);
        addLog("Przypisano: " + pendingUsername + " [" + uidStr + "]");
        globalAnimFrame = 0; 
        globalDisplayInfo = "DODANO KARTE"; 
        digitalWrite(LED_RED, LOW);
        digitalWrite(LED_GREEN, HIGH); 
        playSound(SND_CARD_ENROLLED);
        if (autoExitLearn) { 
          learningMode = false; 
          autoExitLearn = false;
        } 
      } else { 
        bool valid = false;
        int matchedIndex = -1; 
        for (int i = 0; i < totalCards; i++) { 
          if (memcmp(rfid.uid.uidByte, users[i].uid, 4) == 0) { 
            valid = true;
            matchedIndex = i; 
            break; 
          } 
        } 
        if (valid) {
          if (!isCardActive[matchedIndex]) {
            addLog("Odmowa: Zablokowana [" + String(users[matchedIndex].name) + "]");
            playSound(SND_ACCESS_DENIED);
            for (int i = 0; i < 2; i++) { digitalWrite(LED_RED, HIGH); delay(120); digitalWrite(LED_RED, LOW); delay(80); }
          } else if (!cardAllowedNow(matchedIndex)) {
            // Karta poprawna, ale poza swoim oknem czasowym — egzekwowane LOKALNIE.
            addLog("Odmowa: Poza harmonogramem [" + String(users[matchedIndex].name) + "]");
            globalDisplayInfo = "POZA HARMONOGRAMEM";
            playSound(SND_ACCESS_DENIED);
            for (int i = 0; i < 2; i++) { digitalWrite(LED_RED, HIGH); delay(120); digitalWrite(LED_RED, LOW); delay(80); }
          } else {
            openDoor(String(users[matchedIndex].name));
          }
        } else {
          addLog("Odmowa: Nieznany [" + uidStr + "]");
          playSound(SND_ACCESS_DENIED); 
          for (int i = 0; i < 2; i++) { digitalWrite(LED_RED, HIGH); delay(120); digitalWrite(LED_RED, LOW); delay(80); }
        } 
      } 
      // Kolejkujemy zgłoszenie do chmury (rdzeń 0 wyśle je w tle). Pętla leci dalej
      // natychmiast — dioda miga, OLED żyje, potwierdzenie jest od razu.
      if (WiFi.status() == WL_CONNECTED && !req_cardUpload) {
        uidStr.toCharArray(up_uid, sizeof(up_uid));
        pendingUsername.toCharArray(up_name, sizeof(up_name));
        // Slot RZECZYWIŚCIE użyty przez saveNewCard (przy deduplikacji to stary indeks
        // karty, nie koniec listy) — inaczej baza dostaje zły hardware_slot_idx i
        // zmiana nazwy/harmonogram lecą potem do niewłaściwej karty.
        up_slot = (savedSlot >= 0) ? savedSlot : ((totalCards > 0) ? totalCards - 1 : 0);
        up_register = wasLearning;
        req_cardUpload = true;
      }

      rfid.PICC_HaltA();
      rfidResetPending = true;
      lastScanTime = millis();
    }
  }

  if (digitalRead(BUTTON_PIN) == LOW) { 
    unsigned long pressTime = millis();
    bool longPressed = false; 
    while (digitalRead(BUTTON_PIN) == LOW) {
      if (millis() - pressTime > 3000) {
        longPressed = true;
        learningMode = !learningMode;
        autoExitLearn = true;
        if (learningMode) {
          pendingUsername = "Przycisk";
          forceHardwareRFIDReset();
          lastRfidWatchdogTime = millis();
          globalAnimFrame = 0;
          playSound(SND_LEARN_ENTER);
        } else {
          globalDisplayInfo = "";
          playSound(SND_LEARN_EXIT);
        }
        while (digitalRead(BUTTON_PIN) == LOW); break;
      }
      delay(10);
    }
    if (!longPressed && (millis() - pressTime > 50)) { 
      failedLoginAttempts = 0;
      lockoutEndTime = 0; 
      lastRfidWatchdogTime = millis(); 

      // Drzwi otwieramy NATYCHMIAST. Log do chmury to "nice to have" — szedł tu
      // wcześniej PRZED openDoor() i blokował rdzeń 1 na czas handshake'u TLS,
      // czyli fizyczny przycisk reagował z opóźnieniem. Teraz zgłasza go
      // networkTask (rdzeń 0) przy najbliższym cyklu.
      openDoor("PRZYCISK");
      req_buttonLog = true;
    }
  }

  // ── DEDYKOWANY PRZYCISK FACTORY RESET (RESET_BTN_PIN) ──────────────────────
  // Przytrzymanie 3 s podczas normalnej pracy → twardy reset do zera + restart.
  // Bez wypinania zasilania. Odliczanie na OLED, więc nie zresetuje przypadkiem.
  if (digitalRead(RESET_BTN_PIN) == LOW) {
    unsigned long rstPress = millis();
    bool rstWarned = false;
    while (digitalRead(RESET_BTN_PIN) == LOW) {
      unsigned long held = millis() - rstPress;
      if (held > 3000) {
        updateDisplay("FACTORY RESET", "Kasowanie...\nRestart");
        playSound(SND_PROVISION_START);
        factoryResetSettings();
        delay(1200);
        ESP.restart();
      }
      if (held > 400 && !rstWarned) {   // po debounce pokaż odliczanie
        rstWarned = true;
        updateDisplay("RESET FABRYCZNY?", "Trzymaj 3s...\nPusc = anuluj");
      }
      delay(10);
    }
    if (rstWarned) globalDisplayInfo = "";  // puszczono przed 3s → anuluj, wyczyść ekran
  }

  if (doorOpen && millis() > accessEndTime) {
    doorOpen = false;
    relayDeactivate();
    delay(100); 
    forceHardwareRFIDReset(); 
    lastRfidWatchdogTime = millis(); 
    rfidResetPending = false; 
    globalDisplayInfo = ""; 
    digitalWrite(LED_GREEN, LOW); 
    digitalWrite(LED_RED, LOW);
    forceSyncNow = true; // zgłoś zamknięcie od razu, nie czekaj do następnego cyklu
  }
  else {
    if (isOfflineStandby) handleLocalHttp();   // konfiguracja + lokalne API tylko na AP z hasłem
    // POLL USUNIĘTY Z PĘTLI — robi go networkTask na rdzeniu 0. Pętla (rdzeń 1)
    // NIGDY nie blokuje się na handshake TLS → skan RFID natychmiastowy, niezależny
    // od serwera. To była brakująca zmiana, przez którą wcześniej było 3 s.
  }
}

void sendRemoteLog(String message) {
  WiFiClientSecure logClient; configureSecure(logClient);
  logClient.setConnectionTimeout(400);
  if (logClient.connect(PROXMOX_SERVER, PROXMOX_PORT)) {
    // POPRAWKA: to było zahardkodowane na MAC jednego konkretnego zamka
    // testowego, więc logi WSZYSTKICH urządzeń trafiały pod ten sam adres.
    logClient.print("GET /api/hardware/log?mac=" + urlEncode(getMacAddressString()) + "&msg=" + urlEncode(message) + " HTTP/1.1\r\n");
    logClient.print("Host: " + String(PROXMOX_SERVER) + "\r\n");
    printDeviceAuthHeader(logClient);
    logClient.print("Connection: close\r\n\r\n");
    logClient.stop();
  }

}

// =========================================================================
// KOLEJKA KOMEND Z SERWERA — wykonanie (rdzeń 1). README §7.3.
// Karta adresowana po UID (4 bajty hex), więc powtórne doręczenie jest nieszkodliwe,
// a usunięcie jednej karty nie przesuwa celu kolejnych komend (jak przy numerach slotów).
// =========================================================================
static int hexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

static bool hexToBytes(const String& h, uint8_t* out, int maxLen, int& outLen) {
  outLen = 0;
  if (h.length() % 2 != 0 || (int)(h.length() / 2) > maxLen) return false;
  for (unsigned int i = 0; i < h.length(); i += 2) {
    int hi = hexNibble(h[i]), lo = hexNibble(h[i + 1]);
    if (hi < 0 || lo < 0) return false;
    out[outLen++] = (uint8_t)((hi << 4) | lo);
  }
  return true;
}

static int findCardByUidHex(const String& uidHex) {
  uint8_t b[4]; int n = 0;
  if (uidHex.length() != 8 || !hexToBytes(uidHex, b, 4, n) || n != 4) return -1;
  for (int i = 0; i < totalCards; i++) if (memcmp(users[i].uid, b, 4) == 0) return i;
  return -1;
}

void applyPendingCommands() {
  if (!req_cmdsPending) return;
  __sync_synchronize();
  String batch = String(req_cmds);
  unsigned long maxId = cmdAckId;
  bool changed = false;
  int pos = 0;
  while (pos < (int)batch.length()) {
    int semi = batch.indexOf(';', pos);
    if (semi == -1) semi = batch.length();
    String item = batch.substring(pos, semi);
    pos = semi + 1;
    int colon = item.indexOf(':');
    if (colon <= 0) continue;
    unsigned long id = strtoul(item.substring(0, colon).c_str(), NULL, 10);
    if (id == 0 || id <= cmdAckId) continue;           // już wykonana (powtórne doręczenie)
    String cmd = item.substring(colon + 1);
    String f[6]; int nf = 0; int st = 0;
    while (nf < 6) {
      int bar = cmd.indexOf('|', st);
      if (bar == -1) { f[nf++] = cmd.substring(st); break; }
      f[nf++] = cmd.substring(st, bar);
      st = bar + 1;
    }
    char type = f[0].length() ? f[0][0] : 0;

    if (type == 'V' && nf >= 2) {
      // Kod obecności serwisu — tylko na ekranie, nigdy do logu ani do serwera.
      f[1].toCharArray(serviceCode, sizeof(serviceCode));
      serviceCodeUntil = millis() + 15UL * 60UL * 1000UL;
      globalAnimFrame = 0;
      playSound(SND_CLICK_CONFIRM);
      addLog("Sesja serwisowa: kod na ekranie");
    } else if (type == 'G' && nf >= 2) {
      buildDiagnosticReport(f[1].toInt());
    } else if (type == 'R') {
      addLog("Restart na zlecenie serwisu");
      restartAfterAckId = id;   // jak przy Wi-Fi: najpierw ack do serwera, potem restart
    } else if (type == 'W' && nf >= 3) {
      uint8_t sb[33], pb[33]; int sl = 0, pl = 0;
      if (hexToBytes(f[1], sb, 31, sl) && hexToBytes(f[2], pb, 31, pl) && sl > 0) {
        sb[sl] = 0; pb[pl] = 0;
        saveConfiguration(String((char*)sb), String((char*)pb), String(owner_email));
        addLog("Nowa siec Wi-Fi z aplikacji - restart po potwierdzeniu");
        restartAfterAckId = id;
      }
    } else if (nf >= 2) {
      int idx = findCardByUidHex(f[1]);
      if (idx >= 0) {
        if (type == 'A' && nf >= 3) {
          isCardActive[idx] = (f[2] == "1");
          changed = true;
          addLog(isCardActive[idx] ? "Aktywowano: " + String(users[idx].name) : "Zablokowano: " + String(users[idx].name));
        } else if (type == 'D') {
          String gone = String(users[idx].name);
          deleteUser(idx);                                  // zapisuje magazyn sam
          addLog("Usunieto: " + gone);
        } else if (type == 'N' && nf >= 3) {
          uint8_t nb[16]; int nl = 0;
          if (hexToBytes(f[2], nb, 15, nl) && nl > 0) {
            memset(users[idx].name, 0, sizeof(users[idx].name));
            memcpy(users[idx].name, nb, nl);
            changed = true;
          }
        } else if (type == 'S' && nf >= 6) {
          int d = f[3].toInt(), s = f[4].toInt(), e = f[5].toInt();
          cardSchEnabled[idx] = f[2].toInt() ? 1 : 0;
          cardSchDays[idx]  = (uint8_t)(d < 0 ? 127 : (d > 127 ? 127 : d));
          cardSchStart[idx] = (uint16_t)(s < 0 ? 0 : (s > 1440 ? 1440 : s));
          cardSchEnd[idx]   = (uint16_t)(e < 0 ? 0 : (e > 1440 ? 1440 : e));
          changed = true;
        }
      }
    }
    maxId = id;
  }
  if (changed) persistCards();
  cmdAckId = maxId;
  __sync_synchronize();
  req_cmdsPending = false;
  forceSyncNow = true;   // potwierdź wykonanie od razu
}

// =========================================================================
// RAPORT DIAGNOSTYCZNY / SELF-TEST — README §7.15
// mode 0: self-test klienta (bez listy kart, bez przekaźnika)
// mode 1: diagnostyka serwisowa (z listą kart)
// mode 2: jak 1 + krótkie wysterowanie przekaźnika (OTWIERA DRZWI na 400 ms — tylko
//         z potwierdzonej sesji serwisowej, serwer nie zakolejkuje tego nikomu innemu)
// Budowane na rdzeniu 1 (tu są tablice kart i SPI czytnika); wysyła networkTask.
// =========================================================================
static String jsonEscape(const char* s) {
  String o = "";
  for (int i = 0; s[i]; i++) {
    char c = s[i];
    if (c == '"' || c == '\\') { o += '\\'; o += c; }
    else if ((uint8_t)c < 0x20) { o += ' '; }
    else o += c;
  }
  return o;
}

void buildDiagnosticReport(int mode) {
  if (mode < 0 || mode > 2) mode = 0;

  // Czytnik RFID: rejestr wersji 0x91/0x92 = MFRC522 odpowiada; 0x00/0xFF = brak układu/SPI.
  byte rfidVer = rfid.PCD_ReadRegister(MFRC522::VersionReg);

  // Klawiatura: w spoczynku (kolumny HIGH) każdy wiersz musi czytać HIGH. LOW = zwarcie
  // do masy albo brak zewnętrznego rezystora na IO34/IO35.
  bool kpRows[4] = { true, true, true, true };
  if (KEYPAD_INSTALLED) {
    for (int c = 0; c < 3; c++) digitalWrite(KP_COLS[c], HIGH);
    delayMicroseconds(100);
    for (int r = 0; r < 4; r++) kpRows[r] = (digitalRead(KP_ROWS[r]) == HIGH);
  }

  int relayResult = -1;
  if (mode == 2) {
    if (!doorOpen) {
      relayActivate(); delay(400); relayDeactivate();
      relayResult = 1;
      addLog("Serwis: test przekaznika wykonany");
    } else {
      relayResult = 0;
    }
  }

  time_t nowT; time(&nowT);
  String j = "{";
  j += "\"mac\":\"" + getMacAddressString() + "\",";
  j += "\"kind\":" + String(mode) + ",";
  j += "\"fw\":\"" + String(app_version) + "\",";
  char hv[4]; sprintf(hv, "%02X", rfidVer);
  j += "\"rfid_ver\":\"" + String(hv) + "\",";
  j += "\"oled\":" + String(oledConnected ? "true" : "false") + ",";
  j += "\"fs_mounted\":" + String(fsMounted ? "true" : "false") + ",";
  j += "\"fs_selftest\":" + String(fsSelfTestPass ? "true" : "false") + ",";
  j += "\"fs_total\":" + String(fsTotalBytes) + ",\"fs_used\":" + String(fsMounted ? LittleFS.usedBytes() : 0) + ",";
  j += "\"kp_installed\":" + String(KEYPAD_INSTALLED ? "true" : "false") + ",";
  j += "\"kp_rows\":[" + String(kpRows[0] ? "true" : "false") + "," + String(kpRows[1] ? "true" : "false") + "," +
       String(kpRows[2] ? "true" : "false") + "," + String(kpRows[3] ? "true" : "false") + "],";
  j += "\"tamper_installed\":" + String(TAMPER_INSTALLED ? "true" : "false") + ",";
  j += "\"tamper_active\":" + String(tamperActive ? "true" : "false") + ",";
  j += "\"rssi\":" + String(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0) + ",";
  j += "\"ntp\":" + String(nowT >= 100000000 ? "true" : "false") + ",";
  j += "\"heap_free\":" + String(ESP.getFreeHeap()) + ",\"heap_min\":" + String(ESP.getMinFreeHeap()) + ",";
  j += "\"uptime_s\":" + String(millis() / 1000UL) + ",";
  j += "\"reset_reason\":" + String((int)esp_reset_reason()) + ",";
  j += "\"cards_total\":" + String(totalCards);
  if (relayResult >= 0) j += ",\"relay_test\":" + String(relayResult);
  if (mode >= 1) {
    // Lista kart tylko dla serwisu (z potwierdzoną obecnością). UID = pełne 4 bajty,
    // bo serwer porównuje je ze swoją bazą — stąd bierze się wykrywanie rozjazdu (§5.8).
    j += ",\"cards\":[";
    for (int i = 0; i < totalCards; i++) {
      char u[9]; sprintf(u, "%02X%02X%02X%02X", users[i].uid[0], users[i].uid[1], users[i].uid[2], users[i].uid[3]);
      if (i) j += ",";
      j += "{\"u\":\"" + String(u) + "\",\"n\":\"" + jsonEscape(users[i].name) + "\",\"a\":" +
           String(isCardActive[i] ? "true" : "false") + ",\"s\":" + String(cardSchEnabled[i] ? "true" : "false") + "}";
    }
    j += "]";
  }
  j += "}";
  diagPayload = j;
  __sync_synchronize();
  req_diagReport = true;
  addLog(mode == 0 ? "Self-test: raport wyslany" : "Serwis: diagnostyka wyslana");
}

// Wysyłka raportu — TYLKO z networkTask (rdzeń 0), blokujący TLS.
void sendDiagnosticReport() {
  WiFiClientSecure dc; configureSecure(dc);
  dc.setConnectionTimeout(4000);
  if (!dc.connect(PROXMOX_SERVER, PROXMOX_PORT)) return;
  dc.println("POST /api/hardware/diag HTTP/1.1");
  dc.print("Host: "); dc.println(PROXMOX_SERVER);
  printDeviceAuthHeader(dc);
  dc.println("Content-Type: application/json");
  dc.print("Content-Length: "); dc.println(diagPayload.length());
  dc.println("Connection: close\r\n");
  dc.print(diagPayload);
  unsigned long deadline = millis() + 1500;
  while (!dc.available() && dc.connected() && millis() < deadline) vTaskDelay(pdMS_TO_TICKS(10));
  dc.stop();
}

void logKeypadEvent(String message) {
  addLog(message);  // buffered — visible in app on next poll, no blocking
}
