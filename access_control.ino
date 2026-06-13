#include <Wire.h> 
#include <Adafruit_GFX.h> 
#include <Adafruit_SH110X.h>  
#include <SPI.h> 
#include <MFRC522.h> 
#include <WiFiS3.h>  
#include <WiFiUdp.h> 
#include <NTPClient.h> 
#include <EEPROM.h> 
#include "RTC.h" 
#include <ArduinoOTA.h>
#include <WDT.h>  

unsigned long lastOtaCheck = 0;
const unsigned long otaInterval = 10000;

const char* app_version = "v2.9.4";

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
void saveConfiguration(String newSSID, String newPass, String newAdmin, String newTeleIP, int newTelePort, bool enableTele); 
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
void transmitCardPayloadToCloud(String uidStr, byte* rawUid, bool runRegister); 
void sendExternalTelemetry(String logData); 
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
char admin_password[16] = ""; 
char proxmox_log_server[64] = ""; 
int proxmox_log_port = 3000; 
bool telemetryEnabled = false; 

char temporary_password[8] = "";
bool hasTemporaryPassword = false; 

#define RELAY_PIN 4 
#define BUTTON_PIN 5 
#define LED_GREEN 7  
#define LED_RED 6 
#define BUZZER_PIN 8 
#define RST_PIN 9 
#define SS_PIN 10 

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
  sprintf(macBuf, "%02X:%02X:%02X:%02X:%02X:%02X", mac[5], mac[4], mac[3], mac[2], mac[1], mac[0]);
  return String(macBuf);
}

void loadConfiguration() { 
  if (EEPROM.read(250) == 0x55) { 
    EEPROM.get(260, ssid);
    EEPROM.get(292, pass); 
    EEPROM.get(324, admin_password); 
    EEPROM.get(340, proxmox_log_server); 
    EEPROM.get(404, proxmox_log_port); 
    telemetryEnabled = (EEPROM.read(251) == 0x01); 
    provisioningMode = false;  
    hasSavedConfig = true;
  } else { 
    provisioningMode = true;  
    hasSavedConfig = false; 
    strcpy(admin_password, "admin"); 
    strcpy(proxmox_log_server, "192.168.0.200"); 
    proxmox_log_port = 3000;
  } 
} 

void saveConfiguration(String newSSID, String newPass, String newAdmin, String newTeleIP, int newTelePort, bool enableTele) { 
  newSSID.toCharArray(ssid, 32);
  newPass.toCharArray(pass, 32); 
  newAdmin.toCharArray(admin_password, 16); 
  newTeleIP.toCharArray(proxmox_log_server, 64); 
  proxmox_log_port = newTelePort; 
  telemetryEnabled = enableTele; 
  EEPROM.put(260, ssid); 
  EEPROM.put(292, pass); 
  EEPROM.put(324, admin_password); 
  EEPROM.put(340, proxmox_log_server); 
  EEPROM.put(404, proxmox_log_port); 
  EEPROM.write(251, telemetryEnabled ? 0x01 : 0x00); 
  EEPROM.write(250, 0x55);  
  hasTemporaryPassword = false; 
  memset(temporary_password, 0, sizeof(temporary_password));
} 

void factoryResetSettings() { 
  for (int i = 0; i < 512; i++) { 
    EEPROM.write(i, 0xFF);
  } 
  EEPROM.put(0, 0);  
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
} 

void forceHardwareRFIDReset() { 
  digitalWrite(RST_PIN, LOW); 
  delay(30); 
  digitalWrite(RST_PIN, HIGH); 
  delay(30); 
  rfid.PCD_Init();
} 

String getFormattedSystemTime() { 
  RTCTime currentRTCTime; 
  if (RTC.getTime(currentRTCTime)) { 
    char timeBuffer[6];
    sprintf(timeBuffer, "%02d:%02d", currentRTCTime.getHour(), currentRTCTime.getMinutes()); 
    return String(timeBuffer); 
  } 
  return "--:--"; 
} 

void renderSystemUI() { 
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
    int shackleOffset = (globalAnimFrame > 4) ? 
    5 : globalAnimFrame; 
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
  else { 
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
    // 🌟 WYRZUCONO timeClient.begin() - gniazda UDP są bezpieczne!
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

void sendExternalTelemetry(String logData) { 
  if (blockTelemetry || !telemetryEnabled || WiFi.status() != WL_CONNECTED) return; 
  WiFiClient telemetryClient; 
  telemetryClient.setTimeout(150);
  if (telemetryClient.connect(proxmox_log_server, proxmox_log_port)) { 
    telemetryClient.println("POST /log HTTP/1.1"); 
    telemetryClient.print("Host: "); telemetryClient.println(proxmox_log_server); 
    telemetryClient.println("Content-Type: text/plain; charset=utf-8");
    telemetryClient.print("Content-Length: "); telemetryClient.println(logData.length()); 
    telemetryClient.println("Connection: close\r\n"); 
    telemetryClient.print(logData); 
    telemetryClient.flush(); 
    telemetryClient.stop();
  } 
} 

void addLog(String msg) { 
  RTCTime currentRTCTime; 
  RTC.getTime(currentRTCTime); 
  char timeBuffer[12]; 
  sprintf(timeBuffer, "%02d:%02d:%02d", currentRTCTime.getHour(), currentRTCTime.getMinutes(), currentRTCTime.getSeconds());
  String currentTime = String(timeBuffer); 
  if (logCount < MAX_LOGS) { 
    lastActions[logCount++] = {currentTime, msg};
  } else { 
    for (int i = 0; i < MAX_LOGS - 1; i++) { 
      lastActions[i] = lastActions[i+1];
    } 
    lastActions[MAX_LOGS - 1] = {currentTime, msg}; 
  } 
  sendExternalTelemetry(msg);
} 

void openDoor(String source) { 
  doorOpen = true;  
  globalAnimFrame = 0;  
  accessEndTime = millis() + 3000;
  globalDisplayInfo = source; 
  digitalWrite(RELAY_PIN, LOW); 
  digitalWrite(LED_GREEN, HIGH); 
  digitalWrite(LED_RED, LOW); 
  tone(BUZZER_PIN, 1000, 200); 
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
  while (client.available()) { client.read();
  } 
  addLog("REQ=" + reqHeader); 

  if (reqHeader.indexOf("POST /save_setup") != -1 || reqHeader.indexOf("GET /save_setup") != -1) { 
    int sIdx = reqHeader.indexOf("s=") + 2;
    int pIdx = reqHeader.indexOf("&p=") + 3; 
    int aIdx = reqHeader.indexOf("&a=") + 3; 
    int tiIdx = reqHeader.indexOf("&ti=") + 4;
    int tpIdx = reqHeader.indexOf("&tp=") + 4; 
    int teIdx = reqHeader.indexOf("&te="); 
    String rawSSID = reqHeader.substring(sIdx, reqHeader.indexOf("&p=")); 
    String rawPass = reqHeader.substring(pIdx, reqHeader.indexOf("&a="));
    String rawAdmin = reqHeader.substring(aIdx, reqHeader.indexOf("&ti=")); 
    String rawTeleIP = reqHeader.substring(tiIdx, reqHeader.indexOf("&tp=")); 
    int spacePos = reqHeader.indexOf(" ", tpIdx);
    int nextAmp = reqHeader.indexOf("&", tpIdx); 
    int endPortPos = (nextAmp != -1 && nextAmp < spacePos) ? nextAmp : spacePos;
    String nTelePort = reqHeader.substring(tpIdx, endPortPos); 
    bool runTele = (teIdx != -1); 
    String decodedSSID = urlDecode(rawSSID); 
    String decodedPass = urlDecode(rawPass);
    String decodedAdmin = urlDecode(rawAdmin); 
    String decodedTeleIP = urlDecode(rawTeleIP); 

    saveConfiguration(decodedSSID, decodedPass, decodedAdmin, decodedTeleIP, nTelePort.toInt(), runTele);
    client.println("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html><body style='background:#121212;color:#fff;font-family:sans-serif;text-align:center;padding:50px;\'><h2>💾 Ustawienia Zapisane Pomyslnie!</h2></body></html>"); 
    delay(50); client.stop(); 
    tone(BUZZER_PIN, 2000, 800); 
    delay(1000); 
    NVIC_SystemReset();  
    return;
  } 

  client.println("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n"); 
  client.println("<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1.0'>"); 
  client.println("<style>body{background:#121212;color:#fff;font-family:sans-serif;padding:20px;} .box{background:#1e1e1e;padding:20px;border-radius:10px;max-width:400px;margin:20px auto;} input{display:block;width:92%;padding:12px;margin:12px auto;background:#2d2d2d;color:#fff;border:1px solid #444;border-radius:6px;}</style></head><body>"); 
  client.println("<h2 style='text-align:center;'>⚙       CTRLABLE Node Setup</h2><div class='box'><form method='GET' action='/save_setup'>");
  client.println("<input type='text' name='s' value='" + String(ssid) + "' placeholder='SSID Wi-Fi' required>");
  client.println("<input type='password' name='p' value='" + String(pass) + "' placeholder='Password' required>");
  client.println("<input type='password' name='a' value='" + String(admin_password) + "' placeholder='Admin Master Password' required>");
  client.println("<input type='text' name='ti' value='" + String(proxmox_log_server) + "' placeholder='Backend Address / Domain Link' required>");
  client.println("<input type='text' name='tp' value='" + String(proxmox_log_port) + "' placeholder='Port Target' required>"); 
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

  if (reqHeader.indexOf("GET /api/forgot_password") != -1) { 
    long tokenNum = random(100000, 999999);
    sprintf(temporary_password, "%ld", tokenNum); 
    hasTemporaryPassword = true; 
    addLog("RESET: Wygenerowano haslo tymczasowe [" + String(temporary_password) + "]"); 
    globalDisplayInfo = "Klucz tymczasowy wyslany";
    tone(BUZZER_PIN, 1400, 400); 
    client.println("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nOK"); 
    delay(1); client.stop(); blockTelemetry = false; return;
  } 

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
  bool authPermanent = (passPos != -1 && decodedAttempt == String(admin_password));
  bool authTemporary = (passPos != -1 && hasTemporaryPassword && decodedAttempt == String(temporary_password)); 
  bool isAuthenticated = (authPermanent || authTemporary);
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
    tone(BUZZER_PIN, 1500, 100); 
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
    InternalStorage.close(); 
    if (!InternalStorage.open(contentLength)) { 
        client.println("HTTP/1.1 500 Internal Error\r\nConnection: close\r\n"); 
        client.stop();
        addLog("OTA FAILED: InternalStorage.open()"); 
        blockTelemetry = false; 
        return; 
    } 
    uint32_t receivedBytes = 0;
    unsigned long receiveDeadline = millis() + 120000; 
    while (receivedBytes < contentLength && millis() < receiveDeadline) { 
        while (client.available()) { 
            uint8_t b = client.read();
            InternalStorage.write(b); 
            receivedBytes++; 
            receiveDeadline = millis() + 120000; 
            if (receivedBytes >= contentLength) break;
        } 
        delay(1); 
    } 
    InternalStorage.close();
    if (receivedBytes != contentLength) { 
        client.println("HTTP/1.1 408 Timeout\r\nConnection: close\r\n"); 
        client.stop();
        addLog("OTA FAILED: Bytes verification mismatch"); 
        blockTelemetry = false; 
        return; 
    } 
    client.println("HTTP/1.1 200 OK"); 
    client.println("Content-Type: application/json");
    client.println("Connection: close\r\n"); 
    client.println("{\"success\":true}"); 
    delay(100); 
    client.stop(); 
    
    addLog("OTA COMPLETE. APPLYING CORE REWRITE..."); 
    tone(BUZZER_PIN, 1800, 300); delay(100); tone(BUZZER_PIN, 2200, 500); 
    delay(1000); 
    InternalStorage.apply();
    NVIC_SystemReset(); 
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
      client.print("\",\"admin_pass\":\""); client.print(admin_password); 
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
        tone(BUZZER_PIN, 1500, 300);
      } else { 
        addLog("Stop Ucz: Panel API"); 
        tone(BUZZER_PIN, 800, 300);
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
          tone(BUZZER_PIN, 600, 400); 
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
          tone(BUZZER_PIN, 1200, 150);
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
          tone(BUZZER_PIN, 1100, 150); 
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
        tone(BUZZER_PIN, 900, 150);
      } 
      client.println("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nOK"); 
      delay(1); client.stop(); blockTelemetry = false; return;
    } 
    else if (reqHeader.indexOf("/api/save_settings") != -1) { 
      int sIdx = reqHeader.indexOf("s=") + 2;
      int pIdx = reqHeader.indexOf("&p=") + 3; 
      int aIdx = reqHeader.indexOf("&a=") + 3; 
      String nSSID = reqHeader.substring(sIdx, reqHeader.indexOf("&p="));
      String nPass = reqHeader.substring(pIdx, reqHeader.indexOf("&a=")); 
      int nextAmp = reqHeader.indexOf("&", aIdx); 
      int spaceIdx = reqHeader.indexOf(" ", aIdx);
      int endPortPos = (nextAmp != -1 && nextAmp < spaceIdx) ? nextAmp : spaceIdx; 
      String nAdmin = reqHeader.substring(aIdx, endPortPos);
      String decSSID = urlDecode(nSSID); String decPass = urlDecode(nPass); String decAdmin = urlDecode(nAdmin); 
      saveConfiguration(decSSID, decPass, decAdmin, proxmox_log_server, proxmox_log_port, telemetryEnabled); 
      addLog("Zapisano ustawienia");
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
  while (client.available()) { client.read();
  } 
  String expectedAuthSignature = "pass=" + String(admin_password); 
  if (reqHeader.indexOf("GET /installer") != -1 && reqHeader.indexOf(expectedAuthSignature) != -1) { 
    client.println("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n");
    client.println("<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1.0'>"); 
    client.println("<style>body{background:#121212;color:#fff;font-family:sans-serif;padding:20px;} .box{background:#1e1e1e;padding:20px;border-radius:10px;max-width:400px;margin:20px auto;} input{display:block;width:92%;padding:12px;margin:12px auto;background:#2d2d2d;color:#fff;border:1px solid #444;border-radius:6px;}</style></head><body>");
    client.println("<h2 style='text-align:center;'>⚙       Online Installer Portal</h2><div class='box'><form method='GET' action='/save_setup'>");
    client.println("<input type='text' name='s' value='" + String(ssid) + "' placeholder='SSID Wi-Fi' required>");
    client.println("<input type='password' name='p' value='" + String(pass) + "' placeholder='Password' required>");
    client.println("<input type='password' name='a' value='" + String(admin_password) + "' placeholder='Admin Master Password' required>");
    client.println("<input type='text' name='ti' value='" + String(proxmox_log_server) + "' placeholder='Backend Address / Domain Link' required>");
    client.println("<input type='text' name='tp' value='" + String(proxmox_log_port) + "' placeholder='Port Target' required>"); 
    client.println("<input type='submit' style='background:#5c33cf;font-weight:bold;cursor:pointer;' value='Update & Reboot Hardware'></form></div></body></html>"); 
    delay(50); client.stop();
    return; 
  } 
} 

void executeCloudSynchronization() { 
  if (strlen(proxmox_log_server) < 4) return; 
  WiFiClient httpCheck; 
  httpCheck.setTimeout(250); 
  
  if (!httpCheck.connect(proxmox_log_server, proxmox_log_port)) { 
    // 🌟 Jeśli backend Proxmoxa nie odpowiada, po prostu logujemy to seryjnie i wracamy do loop()
    // Nie odłączamy Wi-Fi ani nie podnosimy trybu AP!
    Serial.println("[NET] Serwer Proxmox nieodpowiada. Ponowna proba za 3 sekundy...");
    return; 
  } 
  
  lastSuccessfulPollTime = millis(); 
  String macStr = getMacAddressString(); 
  String pollPath = "/api/hardware/poll?version=" + urlEncode(String(app_version)) + "&mac=" + urlEncode(macStr) + "&opened=" + String(doorOpen ? "1" : "0"); 
  httpCheck.println("GET " + pollPath + " HTTP/1.1");  
  httpCheck.print("Host: "); httpCheck.println(proxmox_log_server);  
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
  if (serverUnlockSignal) {  
    if (!doorOpen) openDoor("Zdalne Wywolanie"); 
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
  
  if (otaClient.connect("192.168.0.200", 3000)) {
    otaClient.setTimeout(5000);
    otaClient.print("GET /api/lock/download-firmware HTTP/1.1\r\n");
    otaClient.print("Host: 192.168.0.200\r\n");
    otaClient.print("Connection: close\r\n\r\n");

    unsigned long contentLength = 0;

    // 🌟 DYNAMICZNE PARSOWANIE NAGŁÓWKÓW HTTP
    while (otaClient.connected()) {
      String line = otaClient.readStringUntil('\n');
      
      // Szukamy linijki z rozmiarem pliku przesyłanym przez Proxmox
      if (line.indexOf("Content-Length:") >= 0) {
        contentLength = line.substring(line.indexOf(":") + 1).toInt();
      }
      
      // Pusta linia (\r lub \r\n) oznacza koniec nagłówków i początek czystego pliku .bin
      if (line == "\r" || line == "\r\n" || line.length() == 0) {
        break;
      }
    }
    
    // Zabezpieczenie: jeśli serwer nie podał rozmiaru, przerywamy, żeby nie uszkodzić Flasha
    if (contentLength == 0) {
      updateDisplay("BŁĄD OTA", "Brak rozmiaru naglowka");
      otaClient.stop();
      delay(3000);
      return;
    }
    
    // Otwieramy InternalStorage na IDEALNĄ wielkość pliku
    if (InternalStorage.open(contentLength)) {
      uint32_t receivedBytes = 0;
      unsigned long receiveDeadline = millis() + 10000; // 10 sekund timeoutu na pakiety
      
      // 🌟 PĘTLA POBIERANIA ZWIĄZANA Z REALNYM ROZMIAREM PLIKU
      while (receivedBytes < contentLength && otaClient.connected()) { 
        while (otaClient.available()) { 
          uint8_t b = otaClient.read();
          InternalStorage.write(b); 
          receivedBytes++; 
          receiveDeadline = millis() + 10000; // Reset timeoutu po każdym odebranym bajcie
          if (receivedBytes >= contentLength) break;
        } 
        
        if (millis() > receiveDeadline) {
          Serial.println("[OTA ERR] Przekroczono limit czasu transmisji danych.");
          break;
        }
        delay(1); 
      } 
      
      InternalStorage.close(); 
      otaClient.stop(); 
      
      // Jeśli odebraliśmy dokładnie tyle bajtów, ile zadeklarował serwer - robimy flash!
      if (receivedBytes == contentLength) {
        updateDisplay("SUKCES OTA", "Wgrywanie i Reset..."); 
        delay(2000); 
        NVIC_SystemReset(); // Płytka wstaje z nowym programem v2.9.5!
      } else {
        updateDisplay("BŁĄD OTA", "Blad sumy bajtow");
        delay(3000);
      }
    } else {
      updateDisplay("BŁĄD OTA", "Brak miejsca flash"); 
      delay(3000);
    }
  } else {
    updateDisplay("BŁĄD OTA", "Brak linku z nodem"); 
    delay(3000);
  }
}

void checkOtaStatusFromServer() {
  WiFiClient client;
  
  if (client.connect("192.168.0.200", 3000)) {
    client.setTimeout(1000);
    
    client.print("GET /api/lock/ota-check HTTP/1.1\r\n");
    client.print("Host: 192.168.0.200\r\n");
    client.print("Connection: close\r\n\r\n");
    
    while (client.connected()) {
      String line = client.readStringUntil('\n');
      
      if (line == "\r" || line == "\r\n" || line.length() == 0) {
        break;
      }
    }
    
    if (client.available()) {
      char response = client.read();
      if (response == '1') {
        performLocalFirmwareUpdate();
      }
    }
    client.stop();
  }
}

void transmitCardPayloadToCloud(String uidStr, byte* rawUid, bool runRegister) { 
  if (strlen(proxmox_log_server) < 4) return; 
  WiFiClient httpPost; 
  httpPost.setTimeout(400);
  if (!httpPost.connect(proxmox_log_server, proxmox_log_port)) return; 
  String endpoint = runRegister ? "/api/hardware/register" : "/api/hardware/scan"; 
  String macStr = getMacAddressString();
  String postData = runRegister ? 
    "{\"mac\":\"" + macStr + "\",\"uid\":\"" + uidStr + "\",\"name\":\"" + pendingUsername + "\",\"slot\":" + String(totalCards > 0 ? totalCards - 1 : 0) + "}" : 
    "{\"mac\":\"" + macStr + "\",\"uid\":\"" + uidStr + "\"}";
  httpPost.println("POST " + endpoint + " HTTP/1.1"); 
  httpPost.print("Host: "); httpPost.println(proxmox_log_server); 
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

void setup() { 
  Serial.begin(9600); 
  delay(1500);
  unsigned long lastOtaCheck = 0;
  const unsigned long otaInterval = 10000; 
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  loadConfiguration(); 
  loadCards(); 
  if (digitalRead(BUTTON_PIN) == LOW) { 
    delay(2000);
    if (digitalRead(BUTTON_PIN) == LOW) { 
      factoryResetSettings(); 
      Serial.println("[FACTORY RESET COMPLETE]");
    } 
  } 
  pinMode(RELAY_PIN, OUTPUT); 
  pinMode(LED_GREEN, OUTPUT); 
  pinMode(LED_RED, OUTPUT); 
  pinMode(RST_PIN, OUTPUT); 
  digitalWrite(RST_PIN, HIGH); 
  delay(50); 
  digitalWrite(RELAY_PIN, HIGH);
  digitalWrite(LED_GREEN, LOW); 
  digitalWrite(LED_RED, LOW); 
  SPI.begin(); 
  RTC.begin(); 
  randomSeed(analogRead(0)); 
  delay(300); 
  display.begin(0x3C, true); 
  display.clearDisplay(); 

  if (provisioningMode) { 
    displayProvisioningInstructions(""); 
    WiFi.beginAP("CTRLABLE_SETUP");
    server.begin(); 
    tone(BUZZER_PIN, 600, 250); 
    delay(300); 
    tone(BUZZER_PIN, 600, 250); 
    unsigned long lastSetupTick = 0; 
    bool alternateState = false;
    while (true) { 
      handleProvisioningServer();
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
    RTCTime localTime(epochTime); 
    RTC.setTime(localTime); 
    forceHardwareRFIDReset(); 
    lastSuccessfulPollTime = millis(); 
    server.begin(); 
    updateDisplay("Gotowy", WiFi.localIP().toString()); 
    addLog("System online"); 
    tone(BUZZER_PIN, 800, 100);  delay(120); 
    tone(BUZZER_PIN, 1000, 100); delay(120);
    tone(BUZZER_PIN, 1300, 120); 
    delay(140); 
    tone(BUZZER_PIN, 1600, 300); 
  } else { 
    isOfflineStandby = true; 
    forceHardwareRFIDReset();
    displayProvisioningInstructions("ERR: CONN TIMEOUT"); 
    WiFi.disconnect(); 
    delay(500); 
    WiFi.beginAP("CTRLABLE_SETUP"); 
    server.begin(); 
    tone(BUZZER_PIN, 300, 600); 
    lastWifiRetryTime = millis(); 
  } 
  lastRfidWatchdogTime = millis();
  lastFrameTick = millis();

  //if (WDT.begin(4000)) {
  //  WDT.refresh(); 
  //} 
}
void loop() {
  // WDT.refresh(); 
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
    
    // Watchdog sprawdzi sieć tylko, jeśli system był wcześniej pomyślnie online
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
        RTCTime localTime(epochTime); 
        RTC.setTime(localTime); 
        server.begin(); 
        updateDisplay("Gotowy", WiFi.localIP().toString()); 
        addLog("Polaczenie Wi-Fi przywrocone"); 
        lastSuccessfulPollTime = millis();
        tone(BUZZER_PIN, 1200, 150); delay(100); tone(BUZZER_PIN, 1500, 150); 
      } else { 
        WiFi.disconnect(); 
        delay(1000);
        WiFi.beginAP("CTRLABLE_SETUP"); 
        delay(500); 
        server.begin(); 
        displayProvisioningInstructions("ERR: REKONEKCJA FAIL"); 
      } 
    } 
  } else { 
    // 🌟 Normalny tryb pracy urządzenia, gdy sieć jest stabilna
    handleWebServer();
    if (WiFi.status() == WL_CONNECTED && millis() - lastPollTime > 1000) { 
      lastPollTime = millis();
      executeCloudSynchronization(); 
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
      transmitCardPayloadToCloud(uidStr, rfid.uid.uidByte, learningMode);
      if (learningMode) { 
        saveNewCard(rfid.uid.uidByte, pendingUsername);
        addLog("Przypisano: " + pendingUsername + " [" + uidStr + "]"); 
        globalAnimFrame = 0; 
        globalDisplayInfo = "DODANO KARTE"; 
        digitalWrite(LED_RED, LOW);
        digitalWrite(LED_GREEN, HIGH); 
        tone(BUZZER_PIN, 1000, 150); delay(150); 
        tone(BUZZER_PIN, 1500, 150); delay(150); 
        tone(BUZZER_PIN, 2000, 400);
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
            tone(BUZZER_PIN, 200, 600); 
          } 
        } else { 
          addLog("Odmowa: Nieznany [" + uidStr + "]");
          tone(BUZZER_PIN, 200, 500); 
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
          tone(BUZZER_PIN, 1500, 400);
        } else { 
          globalDisplayInfo = ""; 
          tone(BUZZER_PIN, 800, 400);
        } 
        while(digitalRead(BUTTON_PIN) == LOW); break;
      } 
      delay(10); 
    } 
    if (!longPressed && (millis() - pressTime > 50)) { 
      failedLoginAttempts = 0;
      lockoutEndTime = 0; 
      lastRfidWatchdogTime = millis(); 

      WiFiClient buttonLogClient; 
      buttonLogClient.setTimeout(150); 
      if (buttonLogClient.connect(proxmox_log_server, proxmox_log_port)) { 
        buttonLogClient.println("GET /api/hardware/log_button HTTP/1.1");
        buttonLogClient.print("Host: "); buttonLogClient.println(proxmox_log_server); 
        buttonLogClient.println("Connection: close\r\n"); 
        buttonLogClient.stop(); 
      } 

      openDoor("PRZYCISK");
    } 
  } 

  if (doorOpen && millis() > accessEndTime) { 
    doorOpen = false;
    digitalWrite(RELAY_PIN, HIGH); 
    delay(100); 
    forceHardwareRFIDReset(); 
    lastRfidWatchdogTime = millis(); 
    rfidResetPending = false; 
    globalDisplayInfo = ""; 
    digitalWrite(LED_GREEN, LOW); 
    digitalWrite(LED_RED, LOW); 
  }
  else { 
    handleWebServer(); 
    if (WiFi.status() == WL_CONNECTED && millis() - lastPollTime > 3000) { 
      executeCloudSynchronization(); 
      lastPollTime = millis();
    } 
  }
}

void sendRemoteLog(String message) {
  WiFiClient logClient;
  message.replace(" ", "%20"); 
  
  if (logClient.connect("192.168.0.200", 3000)) {
    logClient.print("GET /api/hardware/log?mac=64:E8:33:5F:2B:84&msg=" + message + " HTTP/1.1\r\n");
    logClient.print("Host: 192.168.0.200\r\n");
    logClient.print("Connection: close\r\n\r\n");
    logClient.stop();
  }
}