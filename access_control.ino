#include <Wire.h> 
#include <Adafruit_GFX.h> 
#include <Adafruit_SH110X.h>  
#include <SPI.h> 
#include <MFRC522.h> 
#include <WiFi.h>
#include <WiFiUdp.h> 
#include <NTPClient.h> 
#include <EEPROM.h>  
#include <ArduinoOTA.h>
#include <Update.h>
#include <time.h> 

// STRUKTURA SERWERA ZABLOKOWANA NA TWARDO
#define PROXMOX_SERVER "192.168.0.199"
#define PROXMOX_PORT   3000

unsigned long lastOtaCheck = 0;
const unsigned long otaInterval = 10000;
int latestFirmwareReleaseId = 0;
unsigned long installedReleaseId = 0;
const char* app_version = "v3.0.1";

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
String getFactoryAdminPassword();
void addLog(String msg); 
void openDoor(String source); 
void forceHardwareRFIDReset(); 
void displayProvisioningInstructions(String errorContext = "");
void saveConfiguration(String newSSID, String newPass); 
void factoryResetSettings(); 
void loadConfiguration(); 
void loadCards();
void saveNewCard(byte* uid, String nameStr); 
void deleteUser(int index); 
void updateDisplay(String status, String info = ""); 
void renderSystemUI(); 
void handleProvisioningServer();
void handleWebServer(); 
void handleOnlineInstallerServer(); 
void executeCloudSynchronization();
void performLocalFirmwareUpdate(); 
void transmitCardPayloadToCloud(String uidStr, byte* rawUid, bool runRegister); 
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

#define RELAY_PIN   32
#define RELAY_ACTIVE_LOW true   
#define BUTTON_PIN  33   
#define LED_GREEN   25   
#define LED_RED     26   
#define BUZZER_PIN  27   
#define RST_PIN     4    
#define SS_PIN      5   

// ─── ANTI-TAMPER ─────────────────────────────────────────────────────────────
// ★ Ustaw TAMPER_INSTALLED na true dopiero PO fizycznym zamontowaniu przełącznika NC.
//   Bez przełącznika: IO14 = floating HIGH → fałszywy alarm przy każdym starcie!
// Anti-tamper pin — moved to IO36 (IO14 now used for KP_ROW1)
// When installing tamper switch on IO36: add external 10kΩ pull-up to 3.3V
#define TAMPER_PIN       36
#define TAMPER_INSTALLED false   // ← zmień na true gdy przełącznik NC jest zainstalowany

// KLAWIATURA — ustawiona na true (klawiatura jest podłączona)
// Wymagane zmiany sprzętowe przed uruchomieniem:
//  1. ZAMIEŃ 2 KABLE:
//     Kabel który szedł do IO2  → przepnij na IO12
//     Kabel który szedł do IO12 → przepnij na IO2
//     (eliminuje niebieską diodę — IO2 teraz jest wejściem z pull-up, nie wyjściem)
//  2. DODAJ 2 REZYSTORY 10kΩ:
//     IO34 → 10kΩ → 3.3V   (wiersz 3: klawisze 7 8 9)
//     IO35 → 10kΩ → 3.3V   (wiersz 4: klawisze * 0 #)
//     Bez tych rezystorów IO34/IO35 pływają i powodują fałszywe wciśnięcia → pikanie
#define KEYPAD_INSTALLED true    // klawiatura podłączona

// ─── KLAWIATURA 4×3 ──────────────────────────────────────────────────────────
// PO ZAMIANIE KABLI (patrz wyżej):
//  Pin 1 → IO16 (kol: 1 4 7 *)
//  Pin 2 → IO17 (kol: 2 5 8 0)
//  Pin 3 → IO12 (kol: 3 6 9 #)  ← był IO2 (dioda!), teraz IO12
//  Pin 4 → IO2  (wiersz: 1 2 3, INPUT_PULLUP — dioda praktycznie wygaszona)  ← był IO12
//  Pin 5 → IO15 (wiersz: 4 5 6, wewn. pull-up)
//  Pin 6 → IO34 (wiersz: 7 8 9, ZEWN. 10kΩ do 3.3V!)
//  Pin 7 → IO35 (wiersz: * 0 #, ZEWN. 10kΩ do 3.3V!)
#define KP_COL1  16
#define KP_COL2  17
#define KP_COL3  12   // connector pin 5 — col right (3 6 9 #)  [was IO2 = LED pin!]
#define KP_ROW1  14   // connector pin 2 — row 1 (1 2 3)  ← MOVE WIRE from IO2 to IO14
                      // IO2 has the onboard blue LED; its LED circuit pulls IO2 to ~2V
                      // which is below ESP32's HIGH threshold → always reads LOW → constant beeping
                      // IO14 has no LED, internal pull-up works correctly
#define KP_ROW2  15
#define KP_ROW3  34   // ZEWNĘTRZNY 10kΩ do 3.3V wymagany!
#define KP_ROW4  35   // ZEWNĘTRZNY 10kΩ do 3.3V wymagany!

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

bool doorOpen = false; 
bool learningMode = false;
bool autoExitLearn = false;  
bool provisioningMode = false;
bool isOfflineStandby = false;  
bool hasSavedConfig = false;
bool oledConnected = false; 
User users[10];
bool isCardActive[10] = {true, true, true, true, true, true, true, true, true, true};  
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
unsigned long lastSuccessfulPollTime = 0;
int globalAnimFrame = 0; 
unsigned long lastFrameTick = 0; 

bool blockTelemetry = false;
bool systemWasOnline = false;
// Gdy true, najbliższa iteracja loop() wykona executeCloudSynchronization()
// OD RAZU (poza normalnym 1s cyklem), żeby serwer/aplikacja jak najszybciej
// zobaczyły prawdziwy, potwierdzony przez sprzęt stan rygla.
bool forceSyncNow = false;

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
  char ch; 
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

// ALGORYTMICZNE UNIKALNE HASŁO FABRYCZNE
String getFactoryAdminPassword() {
  String mac = getMacAddressString();
  unsigned long hashNum = 0;
  String salt = "CTRLABLE_KEY_2026"; 
  String combined = mac + salt;
  for (unsigned int i = 0; i < combined.length(); i++) {
    hashNum += combined[i] * (i + 1);
  }
  return "CN" + String(hashNum).substring(0, 5);
}

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
  EEPROM.commit();
} 

void loadCards() { 
  EEPROM.get(0, totalCards);
  if (totalCards < 0 || totalCards > 10) { 
    totalCards = 0;
  } 
  for (int i = 0; i < totalCards; i++) { 
    EEPROM.get(10 + (i * sizeof(User)), users[i]);
    isCardActive[i] = (EEPROM.read(220 + i) != 0x00);  
  } 
} 

void saveNewCard(byte* uid, String nameStr) { 
  if (totalCards >= 10) return;
  memset(&users[totalCards], 0, sizeof(User)); 
  memcpy(users[totalCards].uid, uid, 4); 
  nameStr.toCharArray(users[totalCards].name, 16); 
  EEPROM.put(10 + (totalCards * sizeof(User)), users[totalCards]); 
  isCardActive[totalCards] = true;
  EEPROM.write(220 + totalCards, 0x01); 
  totalCards++; 
  EEPROM.put(0, totalCards); 
  EEPROM.commit();
} 

void deleteUser(int index) { 
  if (index < 0 || index >= totalCards) return;
  for (int i = index; i < totalCards - 1; i++) { 
    users[i] = users[i + 1];
    EEPROM.put(10 + (i * sizeof(User)), users[i]); 
    isCardActive[i] = isCardActive[i + 1];  
    EEPROM.write(220 + i, isCardActive[i] ? 0x01 : 0x00);
  } 
  isCardActive[totalCards - 1] = true; 
  EEPROM.write(220 + totalCards - 1, 0x01); 
  totalCards--; 
  EEPROM.put(0, totalCards);
  EEPROM.commit();
} 

void forceHardwareRFIDReset() { 
  digitalWrite(RST_PIN, LOW); 
  delay(30); 
  digitalWrite(RST_PIN, HIGH); 
  delay(30); 
  rfid.PCD_Init();
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
    display.setCursor(0, 48);  display.print("Zdalne odblokowanie");
    display.setCursor(12, 56); display.print("ZABLOKOWANE");
  } else if (kpBuffer.length() > 0 || kpChecking) {
    display.setCursor(28, 16); display.print("Wpisz PIN:");
    display.setTextSize(2);    display.setCursor(10, 30);
    if (kpChecking) {
      display.print("...");
    } else {
      for (int i = 0; i < (int)kpBuffer.length(); i++) display.print('*');
      display.print("_");
    }
    display.setTextSize(1);
    display.setCursor(4, 52);  display.print("# = OK      * = Czyszcz");
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
  if (errorContext != "") { 
    globalDisplayInfo = errorContext + "\nConnect to:\nSSID: CTRLABLE_SETUP\nIP: 192.168.4.1";
  } else { 
    globalDisplayInfo = "INITIAL CONFIG!\nConnect to:\nSSID: CTRLABLE_SETUP\nIP: 192.168.4.1"; 
  } 
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
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, RELAY_ACTIVE_LOW ? LOW : HIGH);
}

void relayDeactivate() {
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, RELAY_ACTIVE_LOW ? HIGH : LOW);
}

void openDoor(String source) { 
  doorOpen = true;  
  globalAnimFrame = 0;  
  accessEndTime = millis() + 3000;
  globalDisplayInfo = source; 
  relayActivate();
  digitalWrite(LED_GREEN, LOW); 
  digitalWrite(LED_RED, HIGH); 
  playSound(SND_ACCESS_GRANTED); 
  forceSyncNow = true; // nie czekamy do następnego cyklu pollingu - zgłoś "opened" natychmiast
  addLog("Otwarto: " + source);
} 

void handleProvisioningServer() { 
  WiFiClient client = server.available(); 
  if (!client) return; 
  String reqHeader = "";
  unsigned long webTimeout = millis() + 2000;  
  while (client.connected() && millis() < webTimeout) {  
    if (client.available()) { 
      char c = client.read();
      reqHeader += c; 
      if (c == '\n') break;  
    } 
  } 
  while (client.available()) { client.read(); } 
  addLog("REQ=" + reqHeader); 

  if (reqHeader.indexOf("POST /save_setup") != -1 || reqHeader.indexOf("GET /save_setup") != -1) { 
    int sIdx = reqHeader.indexOf("s=") + 2;
    int pIdx = reqHeader.indexOf("&p=") + 3; 
    int mIdx = reqHeader.indexOf("&m=") + 3;
    int offIdx = reqHeader.indexOf("&offline=");

    String rawSSID = reqHeader.substring(sIdx, reqHeader.indexOf("&p="));
    String rawPass = reqHeader.substring(pIdx, reqHeader.indexOf("&m=")); 
    String rawEmail = reqHeader.substring(mIdx, reqHeader.indexOf("&reg_pass=")); 
    
    // Pobieramy opcjonalne hasło rejestracji konta z aplikacji
    String rawRegPass = "";
    if (reqHeader.indexOf("&reg_pass=") != -1) {
      int regStart = reqHeader.indexOf("&reg_pass=") + 10;
      rawRegPass = reqHeader.substring(regStart, reqHeader.indexOf("&offline="));
    }
    
    String rawOffline = reqHeader.substring(offIdx + 9, offIdx + 10);

    String decodedSSID = urlDecode(rawSSID); 
    String decodedPass = urlDecode(rawPass);
    String decodedEmail = urlDecode(rawEmail); 
    String decodedRegPass = urlDecode(rawRegPass);

    // Jeśli wybrano tryb offline, symulujemy pomyślny zapis bez sprawdzania połączenia sieciowego
    if (rawOffline == "1" || decodedSSID == "OFFLINE") {
      EEPROM.write(250, 0x55);  // Oznaczamy w pamięci jako skonfigurowany
      saveConfiguration("OFFLINE_MODE", "NONE", decodedEmail);
      // 🌟 Zwracamy MAC + lokalne hasło administratora jako JSON (zamiast samej
      // strony HTML), żeby aplikacja mogła zapisać je u siebie i odtąd rozmawiać
      // z centralką WYŁĄCZNIE lokalnie (http://192.168.4.1), bez konta w chmurze.
      String localPass = getFactoryAdminPassword();
      String macStr = getMacAddressString();
      client.println("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n");
      client.print(",\"tamper\":"); client.print(tamperActive ? "true" : "false"); 
      client.println("{\"status\":\"offline_ready\",\"admin_pass\":\"" + localPass + "\",\"mac\":\"" + macStr + "\"}");
      delay(100); client.stop();
      ESP.restart();
      return;
    }

    // Jeśli instalujemy przez aplikację (Mamy login i hasło), wysyłamy żądanie rejestracji konta na serwer chmurowy
    if (decodedRegPass.length() > 0) {
      WiFi.begin(decodedSSID.c_str(), decodedPass.c_str());
      // Czekamy chwilę na połączenie z ruterem w celu przesłania paczki rejestracyjnej konta
      int attempts = 0;
      while (WiFi.status() != WL_CONNECTED && attempts < 10) { delay(500); attempts++; }
      
      if (WiFi.status() == WL_CONNECTED) {
         WiFiClient registerClient;
         if (registerClient.connect(PROXMOX_SERVER, PROXMOX_PORT)) {
           String postBody = "{\"email\":\"" + decodedEmail + "\",\"password\":\"" + decodedRegPass + "\"}";
           registerClient.println("POST /api/auth/register HTTP/1.1");
           registerClient.println("Host: " + String(PROXMOX_SERVER));
           registerClient.println("Content-Type: application/json");
           registerClient.print("Content-Length: "); registerClient.println(postBody.length());
           registerClient.println("Connection: close\r\n");
           registerClient.print(postBody);
           delay(200); registerClient.stop();
         }
      }
    }

    saveConfiguration(decodedSSID, decodedPass, decodedEmail);
    client.println("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html><body style='background:#121212;color:#fff;font-family:sans-serif;text-align:center;padding:50px;'><h2>💾 Ustawienia Zapisane Pomyslnie!</h2></body></html>"); 
    delay(50); client.stop(); 
    ESP.restart();  
    return;
  } 

  client.println("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n"); 
  client.println("<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1.0'>"); 
  client.println("<style>body{background:#121212;color:#fff;font-family:sans-serif;padding:20px;} .box{background:#1e1e1e;padding:20px;border-radius:10px;max-width:400px;margin:20px auto;} input{display:block;width:92%;padding:12px;margin:12px auto;background:#2d2d2d;color:#fff;border:1px solid #444;border-radius:6px;}</style></head><body>"); 
  client.println("<h2 style='text-align:center;'>⚙ CTRLABLE Node Setup</h2><div class='box'><form method='GET' action='/save_setup'>");
  client.println("<input type='text' name='s' value='" + String(ssid) + "' placeholder='SSID Wi-Fi' required>");
  client.println("<input type='password' id='wifi_pass' name='p' value='" + String(pass) + "' placeholder='Password' required>");
  client.println("<label style='color:#aaa; font-size:14px; display:block; margin:-5px 0 15px 5px; cursor:pointer;'><input type='checkbox' onclick='togglePass()'> Pokaż hasło</label>");
  client.println("<script>function togglePass() { var x = document.getElementById('wifi_pass'); x.type = (x.type === 'password') ? 'text' : 'password'; }</script>");
  client.println("<input type='email' name='m' value='" + String(owner_email) + "' placeholder='Twój adres e-mail w aplikacji' required>");
  client.println("<input type='submit' style='background:#5c33cf;font-weight:bold;cursor:pointer;' value='Save Infrastructure Settings'></form></div></body></html>"); 
  delay(50); client.stop();
} 

void handleWebServer() { 
  WiFiClient client = server.available(); 
  if (!client) return; 
  
  blockTelemetry = true; 
  String reqHeader = "";
  unsigned long webTimeout = millis() + 200;  
  while (client.connected() && millis() < webTimeout) { 
    if (client.available()) { 
      char c = client.read();
      reqHeader += c; 
      if (c == '\n') break; 
    } 
  }
  while (client.available()) { client.read(); } 

  if (failedLoginAttempts >= 5 && millis() < lockoutEndTime) { 
    client.println("HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n[ALERT] LOCKOUT ACTIVE.");
    delay(1); client.stop(); blockTelemetry = false; return; 
  } 

  String attemptedPass = ""; 
  int passPos = reqHeader.indexOf("pass=");
  if (passPos != -1) { 
    int spacePos = reqHeader.indexOf(" ", passPos); 
    int ampPos = reqHeader.indexOf("&", passPos);
    int endPos = spacePos; 
    if (ampPos != -1 && ampPos < spacePos) { 
      endPos = ampPos;
    } 
    attemptedPass = reqHeader.substring(passPos + 5, endPos); 
  } 

  String decodedAttempt = urlDecode(attemptedPass);
  bool authPermanent = (passPos != -1 && decodedAttempt == getFactoryAdminPassword());
  bool isAuthenticated = authPermanent;
  bool isApiRequest = (reqHeader.indexOf("/api/") != -1); 
  if (passPos != -1 && isApiRequest) { 
    if (!isAuthenticated && decodedAttempt.length() > 0) { 
      failedLoginAttempts++;
      if (failedLoginAttempts >= 5) { 
        lockoutEndTime = millis() + 300000;
        addLog("ALARM: Atak BruteForce!"); 
      } 
    } else if (isAuthenticated) { 
      failedLoginAttempts = 0;
    } 
  } 

  if (reqHeader.indexOf("/api/update") != -1) { 
    addLog("OTA REQUEST DETECTED");
    if (!isAuthenticated) { 
      client.println("HTTP/1.1 401 Unauthorized"); 
      client.println("Connection: close\r\n"); 
      client.stop(); 
      blockTelemetry = false; 
      return;
    } 
    updateDisplay("OTA UPDATE", "Receiving firmware..."); 
    playSound(SND_OTA_START); 
    String fullHeader = reqHeader;
    unsigned long headerDeadline = millis() + 5000; 
    while (millis() < headerDeadline) { 
        while (client.available()) { 
            char c = client.read();
            fullHeader += c; 
            if (fullHeader.endsWith("\r\n\r\n")) { 
                goto HEADER_COMPLETE;
            } 
        } 
    } 
HEADER_COMPLETE: 
    int contentLength = 0;
    int clPos = fullHeader.indexOf("Content-Length:"); 
    if (clPos != -1) { 
        int clEnd = fullHeader.indexOf("\r\n", clPos);
        String lengthStr = fullHeader.substring(clPos + 15, clEnd); 
        lengthStr.trim(); 
        contentLength = lengthStr.toInt();
    } 
    if (contentLength <= 0) { 
        client.println("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n");
        client.stop(); 
        addLog("OTA FAILED: Invalid Content-Length"); 
        blockTelemetry = false; 
        return; 
    } 
    addLog("OTA START. SIZE: " + String(contentLength));
    
    Update.abort(); 
    if (!Update.begin(contentLength, U_FLASH)) { 
        client.println("HTTP/1.1 500 Internal Error\r\nConnection: close\r\n"); 
        client.stop();
        addLog("OTA FAILED: Update.begin()"); 
        blockTelemetry = false; 
        return; 
    } 
    uint32_t receivedBytes = 0;
    unsigned long receiveDeadline = millis() + 120000; 
    while (receivedBytes < contentLength && millis() < receiveDeadline) { 
        while (client.available()) { 
            uint8_t b = client.read();
            Update.write(&b, 1); 
            receivedBytes++; 
            receiveDeadline = millis() + 120000; 
            if (receivedBytes >= contentLength) break;
        } 
        delay(1); 
    } 
    if (receivedBytes != contentLength || !Update.end(true)) { 
        client.println("HTTP/1.1 408 Timeout\r\nConnection: close\r\n"); 
        client.stop();
        addLog("OTA FAILED: Mismatch or End Fail"); 
        blockTelemetry = false; 
        return; 
    } 
    client.println("HTTP/1.1 200 OK"); 
    client.println("Content-Type: application/json");
    client.println("Connection: close\r\n"); 
    client.println("{\"success\":true}"); 
    delay(100); 
    client.stop(); 
    
    addLog("OTA COMPLETE. REBOOTING..."); 
    playSound(SND_OTA_SUCCESS);
    unsigned long fanfareDeadline = millis() + 1000;
    while (millis() < fanfareDeadline) { updateBuzzer(); delay(5); } 
    ESP.restart();
    blockTelemetry = false; 
    return; 
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
        client.print(",\"uid\":\""); 
        for(byte j=0; j<4; j++) { 
          if(users[i].uid[j]<0x10) client.print("0"); 
          client.print(users[i].uid[j], HEX); 
          if(j<3) client.print(" "); 
        } 
        client.print("\"}");
        if (i < totalCards - 1) client.print(","); 
      } 
      client.print("],\"logs\":[");
      for (int i = logCount - 1; i >= 0; i--) { 
        client.print("\"[" + lastActions[i].time + "] " + lastActions[i].msg + "\"");
        if (i > 0) client.print(","); 
      } 
      client.print("],\"ssid\":\""); client.print(ssid); 
      client.print(",\"tamper\":"); client.print(tamperActive ? "true" : "false"); 
      client.print("\",\"admin_pass\":\""); client.print(getFactoryAdminPassword()); 
      client.print("\"}");
    } 
    delay(1); client.stop(); blockTelemetry = false; return;
  } 

  if (isAuthenticated) { 
    if (reqHeader.indexOf("/api/unlock") != -1) { 
      if (!doorOpen) openDoor("Panel API");
      client.println("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nOK"); 
      delay(1); client.stop(); blockTelemetry = false; return;
    }  
    else if (reqHeader.indexOf("/api/toggle_learn") != -1) { 
      learningMode = !learningMode;
      autoExitLearn = false;  
      if (learningMode) { 
        if (reqHeader.indexOf("username=") != -1) { 
          int startIdx = reqHeader.indexOf("username=") + 9;
          int endIdx = reqHeader.indexOf(" ", startIdx); 
          if (reqHeader.indexOf("&", startIdx) != -1 && reqHeader.indexOf("&", startIdx) < endIdx) { 
            endIdx = reqHeader.indexOf("&", startIdx);
          } 
          pendingUsername = reqHeader.substring(startIdx, endIdx); 
          pendingUsername.replace("+", " ");
          if(pendingUsername.length() == 0) pendingUsername = "Nowy Uzytkownik"; 
        } 
        forceHardwareRFIDReset(); 
        globalAnimFrame = 0;
        addLog("Tryb Ucz. [" + pendingUsername + "]"); 
        playSound(SND_LEARN_ENTER);
      } else { 
        addLog("Stop Ucz: Panel API"); 
        playSound(SND_LEARN_EXIT);
      } 
      client.println("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nOK"); 
      delay(1); client.stop(); blockTelemetry = false; return;
    }  
    else if (reqHeader.indexOf("/api/delete_user") != -1) { 
      int idxPos = reqHeader.indexOf("idx=");
      if (idxPos != -1) { 
        int targetIdx = reqHeader.substring(idxPos + 4, reqHeader.indexOf(" ", idxPos)).toInt();
        if (targetIdx >= 0 && targetIdx < totalCards) { 
          String deletedName = String(users[targetIdx].name);
          deleteUser(targetIdx); 
          addLog("Usunieto: " + deletedName); 
          playSound(SND_DELETE); 
        } 
      } 
      client.println("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nOK");
      delay(1); client.stop(); blockTelemetry = false; return; 
    } 
    else if (reqHeader.indexOf("/api/rename_user") != -1) { 
      int idxPos = reqHeader.indexOf("idx=");
      int namePos = reqHeader.indexOf("name="); 
      if (idxPos != -1 && namePos != -1) { 
        int targetIdx = reqHeader.substring(idxPos + 4, reqHeader.indexOf("&", idxPos)).toInt();
        String newName = reqHeader.substring(namePos + 5, reqHeader.indexOf(" ", namePos)); 
        newName.replace("+", " ");
        if (targetIdx >= 0 && targetIdx < totalCards && newName.length() > 0) { 
          memset(users[targetIdx].name, 0, 16);
          newName.toCharArray(users[targetIdx].name, 16); 
          EEPROM.put(10 + (targetIdx * sizeof(User)), users[targetIdx]);  
          addLog("Zmiana nazwy slot [" + String(targetIdx) + "]"); 
          playSound(SND_CLICK_CONFIRM);
        } 
      } 
      client.println("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nOK"); 
      delay(1); client.stop();
      blockTelemetry = false; return; 
    }  
    else if (reqHeader.indexOf("/api/toggle_user_active") != -1) { 
      int idxPos = reqHeader.indexOf("idx=");
      if (idxPos != -1) { 
        int targetIdx = reqHeader.substring(idxPos + 4, reqHeader.indexOf(" ", idxPos)).toInt();
        if (targetIdx >= 0 && targetIdx < totalCards) { 
          isCardActive[targetIdx] = !isCardActive[targetIdx];
          EEPROM.write(220 + targetIdx, isCardActive[targetIdx] ? 0x01 : 0x00);  
          addLog(isCardActive[targetIdx] ? "Aktywowano: " + String(users[targetIdx].name) : "Zablokowano: " + String(users[targetIdx].name));
          playSound(SND_CLICK_CONFIRM); 
        } 
      } 
      client.println("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nOK");
      delay(1); client.stop(); blockTelemetry = false; return; 
    } 
    else if (reqHeader.indexOf("/api/clear_logs") != -1) { 
      int tPos = reqHeader.indexOf("time=");
      if (tPos != -1) { 
        int spaceIdx = reqHeader.indexOf(" ", tPos);
        String cutoffVal = reqHeader.substring(tPos + 5, spaceIdx); 
        cutoffVal.replace("%3A", ":");  
        if (cutoffVal == "all") { 
          logCount = 0;
          addLog("Wyczyszczono caly dziennik"); 
        } else if (cutoffVal.indexOf(":") != -1) { 
          int targetH = cutoffVal.substring(0, cutoffVal.indexOf(":")).toInt();
          int targetM = cutoffVal.substring(cutoffVal.indexOf(":") + 1).toInt(); 
          int targetMinutesWeight = (targetH * 60) + targetM; 
          int i = 0;
          while (i < logCount) { 
            int logH = lastActions[i].time.substring(0, 2).toInt();
            int logM = lastActions[i].time.substring(3, 5).toInt(); 
            int logMinutesWeight = (logH * 60) + logM;
            if (logMinutesWeight < targetMinutesWeight) { 
              for (int j = i; j < logCount - 1; j++) { 
                lastActions[j] = lastActions[j + 1];
              } 
              logCount--; 
            } else { i++;
            } 
          } 
          addLog("Usunieto logi starsze niz " + cutoffVal);
        } 
        playSound(SND_CLICK_CONFIRM);
      } 
      client.println("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nOK"); 
      delay(1); client.stop(); blockTelemetry = false; return;
    } 
    else if (reqHeader.indexOf("/api/save_settings") != -1) { 
      int sIdx = reqHeader.indexOf("s=") + 2;
      int pIdx = reqHeader.indexOf("&p=") + 3; 
      int spaceIdx = reqHeader.indexOf(" ", pIdx);
      String nSSID = reqHeader.substring(sIdx, reqHeader.indexOf("&p="));
      String nPass = reqHeader.substring(pIdx, reqHeader.indexOf("&pass=")); 
      String decSSID = urlDecode(nSSID); 
      String decPass = urlDecode(nPass); 
      saveConfiguration(decSSID, decPass, String(owner_email)); 
      addLog("Zapisano ustawienia Wi-Fi");
      client.println("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nOK"); 
      delay(1); client.stop(); blockTelemetry = false; return; 
    } 
  } 
  blockTelemetry = false;
} 

void handleOnlineInstallerServer() { 
  WiFiClient client = server.available(); 
  if (!client) return; 
  String reqHeader = "";
  unsigned long webTimeout = millis() + 250; 
  while (client.connected() && millis() < webTimeout) { if (client.available()) { char c = client.read();
  reqHeader += c;
  if (c == '\n') break; } } 
  while (client.available()) { client.read(); } 
  String expectedAuthSignature = "pass=" + getFactoryAdminPassword(); 
  if (reqHeader.indexOf("GET /installer") != -1 && reqHeader.indexOf(expectedAuthSignature) != -1) { 
    client.println("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n");
    client.println("<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1.0'>"); 
    client.println("<style>body{background:#121212;color:#fff;font-family:sans-serif;padding:20px;} .box{background:#1e1e1e;padding:20px;border-radius:10px;max-width:400px;margin:20px auto;} input{display:block;width:92%;padding:12px;margin:12px auto;background:#2d2d2d;color:#fff;border:1px solid #444;border-radius:6px;}</style></head><body>");
    client.println("<h2 style='text-align:center;'>⚙ Online Installer Portal</h2><div class='box'><form method='GET' action='/save_setup'>");
    client.println("<input type='text' name='s' value='" + String(ssid) + "' placeholder='SSID Wi-Fi' required>");
    client.println("<input type='password' name='p' value='" + String(pass) + "' placeholder='Password' required>");
    client.println("<input type='submit' style='background:#5c33cf;font-weight:bold;color:#fff;cursor:pointer;' value='Update & Reboot Hardware'></form></div></body></html>"); 
    delay(50); client.stop();
    return; 
  } 
} 

void executeCloudSynchronization() { 
  WiFiClient httpCheck;
  httpCheck.setTimeout(250);
  httpCheck.setConnectionTimeout(500);
  if (!httpCheck.connect(PROXMOX_SERVER, PROXMOX_PORT)) { 
    Serial.println("[NET] Serwer Proxmox nie odpowiada. Ponowna proba...");
    return;
  } 
  
  lastSuccessfulPollTime = millis(); 
  String macStr = getMacAddressString();
  String pollPath = "/api/hardware/poll?version=" + urlEncode(String(app_version)) + "&mac=" + urlEncode(macStr) + "&opened=" + String(doorOpen ? "1" : "0") + "&email=" + urlEncode(String(owner_email)) + "&release_id=" + String(installedReleaseId);  httpCheck.println("GET " + pollPath + " HTTP/1.1");  
  httpCheck.print("Host: "); httpCheck.println(PROXMOX_SERVER);  
  httpCheck.println("Connection: close\r\n");  
  unsigned long deadline = millis() + 300;
  String payloadResponse = "";  
  while ((httpCheck.available() || httpCheck.connected()) && millis() < deadline) {  
    if (digitalRead(BUTTON_PIN) == LOW && !doorOpen) openDoor("PRZYCISK");
    if (httpCheck.available()) {  
      char c = httpCheck.read();  
      payloadResponse += c;
    }  
  }  
  httpCheck.stop();  
  
  bool serverUnlockSignal = (payloadResponse.indexOf("\"unlock\":true") != -1);
  bool serverLearnSignal  = (payloadResponse.indexOf("\"learn\":true") != -1); 
  bool serverOtaSignal    = (payloadResponse.indexOf("\"ota\":true") != -1);
  
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

  if (serverOtaSignal) {
    sendRemoteLog("[HARDWARE] Wykryto ota:true w pakiecie poll! Odpalam update.");
    performLocalFirmwareUpdate(); 
    return; 
  }

  if (serverUnlockSignal) {  
    if (tamperActive) {
      addLog("!! BLOKADA: zdalne otwarcie zablokowane (alarm sabotazu)!");
      sendTamperAlert(true);
    } else if (!doorOpen) {
      openDoor("Zdalne Wywolanie");
    }
  }  
  
  if (serverLearnSignal) {  
    learningMode = true;
    int userStart = payloadResponse.indexOf("\"username\":\"");  
    int userEnd = payloadResponse.indexOf("\"", userStart + 12);
    if (userStart > -1 && userEnd > userStart) {  
      pendingUsername = payloadResponse.substring(userStart + 12, userEnd);
    }  
  } else {  
    learningMode = false;
  } 
}

void performLocalFirmwareUpdate() {
  WiFiClient otaClient;
  updateDisplay("AKTUALIZACJA OTA", "Pobieranie pliku...");
  sendRemoteLog("[OTA PULL] Proba polaczenia z serwerem w celu pobrania binu...");
  
  if (otaClient.connect(PROXMOX_SERVER, PROXMOX_PORT)) {
    otaClient.setTimeout(5000);
    String macStr = getMacAddressString();
    otaClient.print("GET /api/lock/download-firmware?mac=" + urlEncode(macStr) + " HTTP/1.1\r\n");
    otaClient.print("Host: " + String(PROXMOX_SERVER) + "\r\n");
    otaClient.print("Connection: close\r\n\r\n");

    unsigned long contentLength = 0;
    while (otaClient.connected()) {
      String line = otaClient.readStringUntil('\n');
      if (line.indexOf("Content-Length:") >= 0) {
        contentLength = line.substring(line.indexOf(":") + 1).toInt();
      }
      if (line == "\r" || line == "\r\n" || line.length() == 0) {
        break;
      }
    }
    
    sendRemoteLog("[OTA PULL] Naglowki przeczytane. Content-Length: " + String(contentLength));
    if (contentLength == 0) {
      updateDisplay("BŁĄD OTA", "Brak rozmiaru naglowka");
      sendRemoteLog("[OTA PULL ERR] Serwer zwrocil rozmiar 0. Przerywam.");
      otaClient.stop();
      delay(3000);
      return;
    }
    
    if (Update.begin(contentLength, U_FLASH)) {
      sendRemoteLog("[OTA PULL] Start szybkiej transmisji blokowej...");
      uint32_t receivedBytes = 0;
      unsigned long receiveDeadline = millis() + 10000; 
      
      uint8_t buffer[256];
      
      // PANCERNA PĘTLA: Czytamy dopóki nie zbierzemy wszystkich bajtów zadeklarowanych w Content-Length
      while (receivedBytes < contentLength) { 
        if (!otaClient.connected() && !otaClient.available()) {
          sendRemoteLog("[OTA PULL ERR] Polaczenie zerwane przed pobraniem calosci.");
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
              receivedBytes += readBytes;
              receiveDeadline = millis() + 10000; 
            } else {
              sendRemoteLog("[OTA PULL ERR] Blad zapisu w pamieci Flash.");
              break;
            }
          }
        } 
        
        if (millis() > receiveDeadline) {
          sendRemoteLog("[OTA PULL ERR] Timeout transmisji.");
          break;
        }
        delay(1);
      } 
      
      otaClient.stop();
      sendRemoteLog("[OTA PULL] Zakonczono pobieranie. Odebrano: " + String(receivedBytes) + "/" + String(contentLength));
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
      sendRemoteLog("[OTA PULL ERR] Brak wolnego miejsca na partycji OTA (begin failed).");
      delay(3000);
    }
  } else {
    updateDisplay("BŁĄD OTA", "Brak linku z nodem");
    sendRemoteLog("[OTA PULL ERR] Nie udalo sie polaczyc z serwerem Proxmox pod " + String(PROXMOX_SERVER));
    delay(3000);
  }
}

void transmitCardPayloadToCloud(String uidStr, byte* rawUid, bool runRegister) { 
  WiFiClient httpPost; 
  httpPost.setTimeout(400);
  if (!httpPost.connect(PROXMOX_SERVER, PROXMOX_PORT)) return; 
  String endpoint = runRegister ? "/api/hardware/register" : "/api/hardware/scan"; 
  String macStr = getMacAddressString();
  String postData = runRegister ? 
    "{\"mac\":\"" + macStr + "\",\"uid\":\"" + uidStr + "\",\"name\":\"" + pendingUsername + "\",\"slot\":" + String(totalCards > 0 ? totalCards - 1 : 0) + "}" : 
    "{\"mac\":\"" + macStr + "\",\"uid\":\"" + uidStr + "\"}";
  httpPost.println("POST " + endpoint + " HTTP/1.1"); 
  httpPost.print("Host: "); httpPost.println(PROXMOX_SERVER); 
  httpPost.println("Content-Type: application/json"); 
  httpPost.print("Content-Length: "); httpPost.println(postData.length()); 
  httpPost.println("Connection: close\r\n"); 
  httpPost.print(postData);
  unsigned long deadline = millis() + 400; 
  String payloadResponse = "";
  while ((httpPost.available() || httpPost.connected()) && millis() < deadline) { 
    if (httpPost.available()) { 
      char c = httpPost.read();
      payloadResponse += c; 
    } 
  } 
  httpPost.stop(); 
} 


// =========================================================================
// ANTI-TAMPER — sendTamperAlert() + checkTamper()
// =========================================================================
void sendTamperAlert(bool active) {
  if (WiFi.status() != WL_CONNECTED) return;
  WiFiClient tc; tc.setTimeout(500);
  tc.setConnectionTimeout(500);
  if (!tc.connect(PROXMOX_SERVER, PROXMOX_PORT)) return;
  String mac  = getMacAddressString();
  String body = "{\"mac\":\"" + mac + "\",\"active\":" + (active ? "true" : "false") + "}";
  tc.println("POST /api/tamper HTTP/1.1");
  tc.print("Host: "); tc.println(PROXMOX_SERVER);
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
  // Read baseline state of the two input-only rows (IO34/IO35) BEFORE driving any column.
  // If they are LOW here it means the pull-up resistor is missing, wrong direction (to GND),
  // or wrong pin — in all those cases we ignore those rows to prevent phantom keypresses.
  int base_r3 = digitalRead(KP_ROW3);  // IO34 — should be HIGH with correct 10kΩ to 3.3V
  int base_r4 = digitalRead(KP_ROW4);  // IO35 — should be HIGH with correct 10kΩ to 3.3V

  for (int c = 0; c < 3; c++) {
    digitalWrite(KP_COLS[c], LOW);
    delayMicroseconds(20);

    for (int r = 0; r < 4; r++) {
      bool pressed = false;
      if (r == 0 || r == 1) {
        // IO2 and IO15: have internal pull-up — simple LOW detection
        pressed = (digitalRead(KP_ROWS[r]) == LOW);
      } else {
        // IO34 (r==2) and IO35 (r==3): no internal pull-up
        // ONLY accept if the baseline was HIGH (pull-up working) AND now reads LOW (key pressed)
        // If baseline was LOW → pull-up missing or wrong → ignore row entirely
        int base = (r == 2) ? base_r3 : base_r4;
        pressed = (base == HIGH) && (digitalRead(KP_ROWS[r]) == LOW);
      }

      if (pressed) {
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
  WiFiClient kc; kc.setTimeout(3000);
  kc.setConnectionTimeout(2000);
  if (!kc.connect(PROXMOX_SERVER, PROXMOX_PORT)) {
    logKeypadEvent("Keypad: blad polaczenia z serwerem"); playSound(SND_ACCESS_DENIED);
    kpChecking = false; renderSystemUI(); return;
  }
  String mac  = getMacAddressString();
  String body = "{\"mac\":\"" + mac + "\",\"pin\":\"" + pin + "\"}";
  kc.println("POST /api/auth/keypad HTTP/1.1");
  kc.print("Host: "); kc.println(PROXMOX_SERVER);
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
  logKeypadEvent("DBG key=[" + String(key) + "] buf=[" + kpBuffer + "]");
  kpLastKey = millis();
  if (key == '#') {
    playSound(SND_KEY_SUBMIT);
    logKeypadEvent("Keypad: # zatwierdzono, len=" + String(kpBuffer.length()));
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
      logKeypadEvent("Keypad: cyfra, len=" + String(kpBuffer.length()));
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
  relayDeactivate();
  pinMode(LED_GREEN, OUTPUT); 
  Serial.begin(9600); 
  delay(1500);
  EEPROM.begin(512);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  // Anti-tamper pin (tylko gdy TAMPER_INSTALLED == true)
  if (TAMPER_INSTALLED) pinMode(TAMPER_PIN, INPUT_PULLUP);
  // Klawiatura — tylko gdy KEYPAD_INSTALLED == true
  // Bez flagi: IO2 nie jest ustawiany jako OUTPUT (nie zapala się niebieska LED),
  //            IO34/IO35 nie są inicjowane (nie pływają, brak fałszywych wciśnięć)
  if (KEYPAD_INSTALLED) {
    for (int c = 0; c < 3; c++) { pinMode(KP_COLS[c], OUTPUT); digitalWrite(KP_COLS[c], HIGH); }
    pinMode(KP_ROW1, INPUT_PULLUP);  // IO14 — wewnętrzny pull-up, brak diody LED
    pinMode(KP_ROW2, INPUT_PULLUP);  // IO15
    pinMode(KP_ROW3, INPUT);         // IO34 - needs external 10k to 3.3V
    pinMode(KP_ROW4, INPUT);         // IO35 - needs external 10k to 3.3V
    delay(50);
  }
  Wire.begin();
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

  // 4. 🌟 NAPRAWA RFID: Czyste uruchomienie SPI i natychmiastowy start czytnika
  SPI.begin(); 
  rfid.PCD_Init();

  // 5. Ładowanie konfiguracji z pamięci
  loadConfiguration(); 
  loadCards();

  // Obsługa przycisku Factory Reset przy starcie
  if (digitalRead(BUTTON_PIN) == LOW) { 
    delay(2000);
    if (digitalRead(BUTTON_PIN) == LOW) { 
      factoryResetSettings(); 
      Serial.println("[FACTORY RESET COMPLETE]");
    } 
  } 
  
  randomSeed(analogRead(0)); 
  delay(300); 

  // 6. Bezpieczne wejście w tryb konfiguracji (ekran i RFID już działają)
  if (provisioningMode) { 
    displayProvisioningInstructions(""); 
    WiFi.softAP("CTRLABLE_SETUP");
    server.begin(); 
    playSound(SND_PROVISION_START); 
    unsigned long lastSetupTick = 0; 
    bool alternateState = false;
    while (true) { 
      handleProvisioningServer();
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
    WiFi.softAP("CTRLABLE_SETUP");
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
      server.begin();
      updateDisplay("Gotowy", WiFi.localIP().toString()); 
      addLog("System online"); 
      playSound(SND_WIFI_CONNECTED);
    } else { 
      isOfflineStandby = true; 
      forceHardwareRFIDReset();
      displayProvisioningInstructions("ERR: CONN TIMEOUT"); 
      WiFi.disconnect(); 
      delay(500); 
      WiFi.softAP("CTRLABLE_SETUP"); 
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
}

void loop() {
  updateBuzzer(); // serwisuje aktualnie odtwarzaną melodię - zero delay(), zero blokowania
  checkTamper();  // anti-tamper (brak efektu gdy TAMPER_INSTALLED == false)
  checkKeypad();  // obsługa matrycy klawiatury PIN

  if (millis() - lastFrameTick > 80) { 
    lastFrameTick = millis();
    globalAnimFrame++; 
    renderSystemUI();
  } 

  if (!doorOpen && !learningMode && (millis() - lastRfidWatchdogTime > 120000)) { 
    lastRfidWatchdogTime = millis();
    forceHardwareRFIDReset(); 
  } 

  if (isOfflineStandby) { 
    handleProvisioningServer();
    if (systemWasOnline && (millis() - lastWifiRetryTime > 60000)) { 
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
        server.begin(); 
        updateDisplay("Gotowy", WiFi.localIP().toString()); 
        addLog("Polaczenie Wi-Fi przywrocone"); 
        lastSuccessfulPollTime = millis();
        playSound(SND_WIFI_RESTORED);
      } else { 
        WiFi.disconnect(); 
        delay(1000);
        WiFi.softAP("CTRLABLE_SETUP"); 
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
      // Nie ma sensu próbować łączyć się z chmurą, gdy nie mamy Wi-Fi - to
      // tylko zbędne opóźnienie (do 400ms) na każdym skanie w trybie offline.
      if (WiFi.status() == WL_CONNECTED) {
        transmitCardPayloadToCloud(uidStr, rfid.uid.uidByte, learningMode);
      }
      if (learningMode) { 
        saveNewCard(rfid.uid.uidByte, pendingUsername);
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
          if (isCardActive[matchedIndex]) { 
            openDoor(String(users[matchedIndex].name));
          } else { 
            addLog("Odmowa: Zablokowana [" + String(users[matchedIndex].name) + "]");
            playSound(SND_ACCESS_DENIED); 
          } 
        } else { 
          addLog("Odmowa: Nieznany [" + uidStr + "]");
          playSound(SND_ACCESS_DENIED); 
        } 
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
        while(digitalRead(BUTTON_PIN) == LOW); break;
      } 
      delay(10); 
    } 
    if (!longPressed && (millis() - pressTime > 50)) { 
      failedLoginAttempts = 0;
      lockoutEndTime = 0; 
      lastRfidWatchdogTime = millis(); 

      // Logowanie naciśnięcia przycisku do chmury jest "nice to have", nie
      // krytyczne - pomijamy je całkowicie offline, by nie czekać na nic.
      if (WiFi.status() == WL_CONNECTED) {
        WiFiClient buttonLogClient; 
        buttonLogClient.setTimeout(150); 
        if (buttonLogClient.connect(PROXMOX_SERVER, PROXMOX_PORT)) { 
          buttonLogClient.println("GET /api/hardware/log_button HTTP/1.1");
          buttonLogClient.print("Host: "); buttonLogClient.println(PROXMOX_SERVER); 
          buttonLogClient.println("Connection: close\r\n"); 
          buttonLogClient.stop(); 
        } 
      }

      openDoor("PRZYCISK");
    } 
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
    handleWebServer(); 
    // Skrócone z 3000ms na 1000ms + natychmiastowy sync po openDoor()/zamknięciu
    // (forceSyncNow), żeby aplikacja zawsze zdążyła zobaczyć potwierdzone przez
    // sprzęt "otwarte", zanim 3-sekundowe okno otwarcia drzwi się skończy.
    if (WiFi.status() == WL_CONNECTED && (forceSyncNow || millis() - lastPollTime > 1000)) { 
      executeCloudSynchronization();
      lastPollTime = millis();
      forceSyncNow = false;
    } 
  }
}

void sendRemoteLog(String message) {
  WiFiClient logClient;
  if (logClient.connect(PROXMOX_SERVER, PROXMOX_PORT)) {
    // POPRAWKA: to było zahardkodowane na MAC jednego konkretnego zamka
    // testowego, więc logi WSZYSTKICH urządzeń trafiały pod ten sam adres.
    logClient.print("GET /api/hardware/log?mac=" + urlEncode(getMacAddressString()) + "&msg=" + urlEncode(message) + " HTTP/1.1\r\n");
    logClient.print("Host: " + String(PROXMOX_SERVER) + "\r\n");
    logClient.print("Connection: close\r\n\r\n");
    logClient.stop();
  }

}

void logKeypadEvent(String message) {
  addLog(message);
  if (WiFi.status() == WL_CONNECTED) sendRemoteLog(message);
}
