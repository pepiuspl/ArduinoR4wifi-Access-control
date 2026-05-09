#include <Arduino_ESP32_OTA.h>
#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <SPI.h>
#include <MFRC522.h>
#include <WiFiS3.h>
#include <ArduinoOTA.h>
#include <WiFiUdp.h>
#include <NTPClient.h>
#include <EEPROM.h> // Added for permanent storage

// --- PINS ---
#define RELAY_PIN 4
#define BUTTON_PIN 5
#define LED_GREEN 6 
#define LED_RED 7   
#define BUZZER_PIN 8
#define RST_PIN 9
#define SS_PIN 10

// --- OBJECTS ---
Adafruit_SSD1306 display(128, 64, &Wire, -1);
MFRC522 rfid(SS_PIN, RST_PIN);
WiFiServer server(80);
WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP, "europe.pool.ntp.org", 3600); 

// --- DATA ---
const char* ssid = "wifi_archer"; 
const char* password = "kupsenetabiedaku1!"; 
const char* admin_pass = "1234";

byte knownUIDs[10][4]; // Now loaded from EEPROM
int totalCards = 0;
bool learningMode = false;

struct LogEntry { String time; String msg; };
LogEntry lastActions[30];
int logCount = 0;

bool isAuthenticated = false;
unsigned long accessEndTime = 0;
bool doorOpen = false;

// --- STORAGE LOGIC ---

void loadCards() {
  EEPROM.get(0, totalCards);
  if (totalCards < 0 || totalCards > 10) totalCards = 0;
  for (int i = 0; i < totalCards; i++) {
    for (int j = 0; j < 4; j++) {
      knownUIDs[i][j] = EEPROM.read(10 + (i * 4) + j);
    }
  }
}

void saveNewCard(byte* uid) {
  if (totalCards >= 10) return;
  for (int j = 0; j < 4; j++) {
    knownUIDs[totalCards][j] = uid[j];
    EEPROM.write(10 + (totalCards * 4) + j, uid[j]);
  }
  totalCards++;
  EEPROM.write(0, totalCards);
}

// --- SYSTEM FUNCTIONS ---

void updateDisplay(String status, String info = "") {
  display.clearDisplay();
  display.setCursor(0,0);
  display.setTextSize(1);
  display.println("Zamek ver 2.0");
  display.println("---------------------");
  display.println("Status: " + status);
  display.println(info);
  display.display();
}

void addLog(String msg) {
  timeClient.update();
  String currentTime = (WiFi.status() == WL_CONNECTED) ? timeClient.getFormattedTime() : "00:00";
  if (logCount < 30) {
    lastActions[logCount++] = {currentTime, msg};
  } else {
    for (int i = 0; i < 29; i++) lastActions[i] = lastActions[i+1];
    lastActions[29] = {currentTime, msg};
  }
}

void openDoor(String source) {
  doorOpen = true;
  accessEndTime = millis() + 3000;
  digitalWrite(RELAY_PIN, LOW);
  digitalWrite(LED_GREEN, HIGH);
  digitalWrite(LED_RED, LOW);
  tone(BUZZER_PIN, 1000, 200);
  updateDisplay("OTWARTE", source);
  addLog("Otwarto: " + source);
}

void handleWebClient() {
  WiFiClient client = server.available();
  if (!client) return;

  String request = "";
  unsigned long timeout = millis() + 100;
  while (client.connected() && millis() < timeout) {
    if (client.available()) {
      char c = client.read();
      request += c;
      if (c == '\n') break; 
    }
  }

  if (request.indexOf("pass=" + String(admin_pass)) != -1) isAuthenticated = true;
  if (isAuthenticated) {
    if (request.indexOf("/unlock") != -1) openDoor("Panel WWW");
    if (request.indexOf("/learn") != -1) {
      learningMode = true;
      rfid.PCD_Init(); // Re-init RFID when entering learn mode
    }
    if (request.indexOf("/logout") != -1) isAuthenticated = false;
  }

  client.println("HTTP/1.1 200 OK\nContent-type:text/html\nConnection: close\n");
  client.println("<!DOCTYPE html><html><head><meta charset='UTF-8'>");
  client.println("<style>body{font-family:sans-serif; background:#f4f4f4; text-align:center;} .card{background:white; margin:20px auto; padding:20px; border-radius:10px; max-width:400px; box-shadow:0 4px 8px rgba(0,0,0,0.1);}");
  client.println(".btn{display:block; width:100%; padding:15px; margin:10px 0; border-radius:5px; text-decoration:none; color:white; font-weight:bold;} .btn-open{background:#27ae60;} .btn-add{background:#2980b9;} .btn-logout{background:#c0392b;}</style></head><body>");

  if (!isAuthenticated) {
    client.println("<div class='card'><h2>🔐 Logowanie</h2><form action='/login'><input type='password' name='pass'><br><br><input type='submit' value='Zaloguj' class='btn btn-open'></form></div>");
  } else {
    client.println("<div class='card'><h2>🏠 Panel admin</h2><p>Drzwi: " + String(doorOpen ? "OTWARTE" : "ZAMKNIETE") + "</p>");
    client.println("<a href='/unlock' class='btn btn-open'>OTWÓRZ</a>");
    client.println("<a href='/learn' class='btn btn-add'>" + String(learningMode ? "!!! TRYB UCZENIA !!!" : "DODAJ KARTE") + "</a>");
    client.println("<div style='text-align:left;'><h3>Logi:</h3>");
    for(int i = logCount - 1; i >= 0; i--) {
      client.println("<div style='font-size:0.8em; border-bottom:1px solid #eee;'>" + lastActions[i].time + " - " + lastActions[i].msg + "</div>");
    }
    client.println("</div><br><a href='/logout' style='color:red;'>Wyloguj</a></div>");
  }
  client.println("</body></html>");
  client.stop();
}

void setup() {
  Serial.begin(115200);
  loadCards(); // Load cards from EEPROM
  
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(LED_GREEN, OUTPUT);
  pinMode(LED_RED, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  
  digitalWrite(RELAY_PIN, HIGH);
  digitalWrite(LED_GREEN, LOW);
  digitalWrite(LED_RED, HIGH);

  SPI.begin();
  rfid.PCD_Init();
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  updateDisplay("Laczenie WiFi...");

  WiFi.begin(ssid, password);
  unsigned long startWait = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startWait < 10000) { delay(500); }
  
  if(WiFi.status() == WL_CONNECTED) {
    server.begin();
    timeClient.begin();
    ArduinoOTA.begin(WiFi.localIP(), "Zamek_R4", "password_ota", InternalStorage);
    updateDisplay("Gotowy", WiFi.localIP().toString());
  }
}

void loop() {
  ArduinoOTA.handle();

  // 1. Learning Mode Visual Indicator (Blinking)
  if (learningMode && (millis() % 500 < 250)) {
    digitalWrite(LED_RED, LOW);
  } else if (!doorOpen) {
    digitalWrite(LED_RED, HIGH);
  }

  // 2. Physical Button
  if (digitalRead(BUTTON_PIN) == LOW) {
    delay(50);
    if(digitalRead(BUTTON_PIN) == LOW) {
      openDoor("Przycisk");
      while(digitalRead(BUTTON_PIN) == LOW) { ArduinoOTA.handle(); } 
    }
  }

  // 3. RFID Check
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    if (learningMode) {
      saveNewCard(rfid.uid.uidByte);
      addLog("Dodano Karte!");
      tone(BUZZER_PIN, 1500, 500);
      learningMode = false;
      updateDisplay("DODANO KARTE");
    } else {
      bool valid = false;
      for (int i = 0; i < totalCards; i++) {
        if (memcmp(rfid.uid.uidByte, knownUIDs[i], 4) == 0) valid = true;
      }
      if (valid) openDoor("RFID");
      else {
        addLog("Odmowa RFID");
        tone(BUZZER_PIN, 200, 500);
      }
    }
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
  }

  // 4. Timer
  if (doorOpen && millis() > accessEndTime) {
    doorOpen = false;
    digitalWrite(RELAY_PIN, HIGH);
    digitalWrite(LED_GREEN, LOW);
    digitalWrite(LED_RED, HIGH);
    updateDisplay("Zamkniete");
  }

  if (WiFi.status() == WL_CONNECTED) handleWebClient();
}