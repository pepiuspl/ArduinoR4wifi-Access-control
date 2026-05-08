#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <SPI.h>
#include <MFRC522.h>
#include <WiFiS3.h>
#include <ArduinoOTA.h>
#include "Arduino_LED_Matrix.h"

// --- PINS & CONSTANTS ---
#define RELAY_PIN 4
#define STATUS_LED 6
#define BUTTON_PIN 5
#define BUZZER_PIN 8
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define RST_PIN 9
#define SS_PIN 10

// --- OBJECTS ---
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
MFRC522 rfid(SS_PIN, RST_PIN);
ArduinoLEDMatrix matrix;
WiFiServer server(80);

// --- SETTINGS & DATA ---
const char* ssid = "wifi_archer"; 
const char* password = "kupsenetabiedaku1!"; 
const char* admin_pass = "1234"; // Dashboard Password

// RFID Storage (Expanded to 10 slots)
byte knownUIDs[10][4] = {
  {0x8B, 0x86, 0x07, 0x05},
  {0x06, 0x12, 0xAA, 0x02}
};
int totalCards = 2;
bool learningMode = false;

// Logs
String lastActions[5];
int logIndex = 0;

bool isAuthenticated = false;
unsigned long accessEndTime = 0;
bool doorOpen = false;

// --- FUNCTIONS ---

void addLog(String msg) {
  lastActions[logIndex] = msg;
  logIndex = (logIndex + 1) % 5;
  Serial.println(msg);
}

void openDoor(String source) {
  doorOpen = true;
  accessEndTime = millis() + 3000;
  digitalWrite(RELAY_PIN, LOW);
  digitalWrite(STATUS_LED, LOW);
  addLog("Otwarto: " + source);
}

// --- WEB SERVER PAGES ---

void sendHeader(WiFiClient& client) {
  client.println("HTTP/1.1 200 OK");
  client.println("Content-type:text/html");
  client.println("Connection: close");
  client.println();
  client.println("<!DOCTYPE html><html><head>");
  client.println("<meta charset='UTF-8'><meta name='viewport' content='width=device-width, initial-scale=1'>");
  client.println("<style>body{font-family:sans-serif; background:#f4f4f4; text-align:center;} .card{background:white; margin:20px auto; padding:20px; border-radius:10px; max-width:400px; box-shadow:0 4px 8px rgba(0,0,0,0.1);}");
  client.println(".btn{display:block; width:100%; padding:15px; margin:10px 0; border:none; border-radius:5px; font-size:18px; cursor:pointer;} .btn-open{background:#27ae60; color:white;} .btn-add{background:#2980b9; color:white;} .btn-logout{background:#c0392b; color:white;}</style>");
  client.println("</head><body>");
}

void handleWebClient() {
  WiFiClient client = server.available();
  if (!client) return;

  String request = client.readStringUntil('\r');
  client.flush();

  // Logic: Routing
  if (request.indexOf("GET /login?pass=") != -1) {
    if (request.indexOf("pass=" + String(admin_pass)) != -1) isAuthenticated = true;
  } else if (request.indexOf("GET /logout") != -1) {
    isAuthenticated = false;
  } else if (isAuthenticated && request.indexOf("GET /unlock") != -1) {
    openDoor("Zdalnie");
  } else if (isAuthenticated && request.indexOf("GET /learn") != -1) {
    learningMode = true;
  }

  sendHeader(client);

  if (!isAuthenticated) {
    // LOGIN PAGE
    client.println("<div class='card'><h1>🔐 Zamek Logowanie</h1>");
    client.println("<form action='/login'><input type='password' name='pass' placeholder='Hasło' style='padding:10px; width:80%'><br><br>");
    client.println("<input type='submit' value='Zaloguj' class='btn btn-open'></form></div>");
  } else {
    // DASHBOARD
    client.println("<div class='card'><h1>🏠 Panel Sterowania</h1>");
    client.println("<p>Status: " + String(doorOpen ? "OTWARTE" : "ZAMKNIĘTE") + "</p>");
    client.println("<a href='/unlock'><button class='btn btn-open'>OTWÓRZ ZDALNIE</button></a>");
    client.println("<a href='/learn'><button class='btn btn-add'>" + String(learningMode ? "TRYB UCZENIA..." : "DODAJ NOWĄ KARTĘ") + "</button></a>");
    
    client.println("<h3>Ostatnie akcje:</h3><ul style='text-align:left;'>");
    for(int i=0; i<5; i++) {
      if(lastActions[i] != "") client.println("<li>" + lastActions[i] + "</li>");
    }
    client.println("</ul>");
    client.println("<a href='/logout' style='color:red;'>Wyloguj</a></div>");
  }

  client.println("</body></html>");
  client.stop();
}

void setup() {
  Serial.begin(115200);
  SPI.begin();
  rfid.PCD_Init();
  matrix.begin();
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(STATUS_LED, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  digitalWrite(RELAY_PIN, HIGH);
  digitalWrite(STATUS_LED, HIGH);

  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) delay(500);
  
  server.begin();
  ArduinoOTA.begin(WiFi.localIP(), "Zamek_R4", "password_ota", InternalStorage);
  addLog("System uruchomiony");
}

void loop() {
  ArduinoOTA.handle();
  handleWebClient();

  // Close door timer
  if (doorOpen && millis() > accessEndTime) {
    doorOpen = false;
    digitalWrite(RELAY_PIN, HIGH);
    digitalWrite(STATUS_LED, HIGH);
  }

  // RFID Logic
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    if (learningMode) {
      if (totalCards < 10) {
        memcpy(knownUIDs[totalCards], rfid.uid.uidByte, 4);
        totalCards++;
        addLog("Dodano nową kartę!");
        learningMode = false;
      }
    } else {
      bool valid = false;
      for (int i = 0; i < totalCards; i++) {
        if (memcmp(rfid.uid.uidByte, knownUIDs[i], 4) == 0) valid = true;
      }
      if (valid) openDoor("Karta RFID");
      else addLog("Odmowa: Nieznana karta");
    }
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
  }
}