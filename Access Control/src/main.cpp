#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <SPI.h>
#include <MFRC522.h>
#include <WiFiS3.h>
#include <ArduinoOTA.h>
#include "Arduino_LED_Matrix.h"

// --- PINY ---
#define RELAY_PIN 4    // PRZEKAŹNIK (S)
#define STATUS_LED 6   // DIODA R (STATUS)
#define BUTTON_PIN 5   // PRZYCISK WYJŚCIA
#define BUZZER_PIN 8   // BUZZER

// --- OLED ---
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

// --- RFID ---
#define RST_PIN 9
#define SS_PIN 10
MFRC522 rfid(SS_PIN, RST_PIN);

// --- MATRYCA I SERWER ---
ArduinoLEDMatrix matrix;
WiFiServer server(80);

// --- DANE ---
const char* ssid = "wifi_archer"; 
const char* password = "kupsenetabiedaku1!"; 
const char* www_pass = "1234";

byte knownUIDs[][4] = {
  {0x8B, 0x86, 0x07, 0x05},
  {0x06, 0x12, 0xAA, 0x02},
  {0x03, 0x58, 0x69, 0x20},
  {0x24, 0x0E, 0xE2, 0xA7}
};

// Ikony Matrycy
const uint32_t icon_heart[] = { 0x3184a444, 0x44042081, 0x100a0040 };
const uint32_t icon_error[] = { 0x811c24, 0x40811, 0xc2408100 };

bool accessGranted = false;
unsigned long accessEndTime = 0;

void playTone(int freq, int duration) {
  tone(BUZZER_PIN, freq, duration);
}

void showMessage(const String &line1, const String &line2 = "") {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 20);
  display.println(line1);
  display.setCursor(0, 40);
  display.println(line2);
  display.display();
}

void openDoor(String source) {
  accessGranted = true;
  accessEndTime = millis() + 3000;
  
  digitalWrite(RELAY_PIN, LOW); 
  digitalWrite(STATUS_LED, LOW); 
  
  matrix.loadFrame(icon_heart);
  playTone(2500, 200); 
  delay(50); 
  playTone(3000, 300);
  
  showMessage("ZAPRASZAM!", source);
  Serial.println("Otwarto przez: " + source);
}

void setup() {
  Serial.begin(115200);
  SPI.begin();
  rfid.PCD_Init();
  matrix.begin();

  if(!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("OLED Fail");
  }

  pinMode(RELAY_PIN, OUTPUT);
  pinMode(STATUS_LED, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(BUZZER_PIN, OUTPUT);
  
  digitalWrite(RELAY_PIN, HIGH); 
  digitalWrite(STATUS_LED, HIGH);   

  showMessage("LACZENIE WiFi...", ssid);

  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  // --- START OTA (Standardowe dla R4) ---
  ArduinoOTA.begin(WiFi.localIP(), "Zamek_R4", "password_ota", InternalStorage);

  server.begin();
  showMessage("GOTOWY!", WiFi.localIP().toString());
  playTone(2000, 150); 
}

void loop() {
  // Obsługa OTA
  ArduinoOTA.handle();

  if (accessGranted && millis() > accessEndTime) {
    accessGranted = false;
    digitalWrite(RELAY_PIN, HIGH);
    digitalWrite(STATUS_LED, HIGH);
    matrix.clear();
    showMessage("PRZYLOZ KARTE", "");
    rfid.PCD_Init(); 
  }

  if (digitalRead(BUTTON_PIN) == LOW && !accessGranted) {
    openDoor("PRZYCISK");
  }

  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    bool valid = false;
    for (int i = 0; i < 4; i++) {
      bool match = true;
      for (int j = 0; j < 4; j++) {
        if (rfid.uid.uidByte[j] != knownUIDs[i][j]) match = false;
      }
      if (match) valid = true;
    }

    if (valid) {
      openDoor("KARTA RFID");
    } else {
      matrix.loadFrame(icon_error);
      playTone(400, 600);
      showMessage("ODMOWA", "Karta nieznana");
      delay(1500);
      matrix.clear();
      showMessage("PRZYLOZ KARTE", "");
    }
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
  }

  WiFiClient client = server.available();
  if (client) {
    String req = client.readStringUntil('\r');
    if (req.indexOf("pass=" + String(www_pass)) != -1) {
      openDoor("WWW");
    }

    client.println("HTTP/1.1 200 OK\nContent-type:text/html\n\n<html><head>");
    client.println("<meta name='viewport' content='width=device-width, initial-scale=1'><meta charset='UTF-8'>");
    client.println("<style>body{text-align:center;font-family:sans-serif;background:#eee;padding-top:50px;} .btn{background:#27ae60;color:white;padding:25px;border:none;border-radius:15px;font-size:30px;width:90%;}</style>");
    client.println("</head><body>");
    client.println("<h1>🔓 Zamek Arduino R4</h1>");
    client.println("<form action='/' method='GET'>");
    client.println("<input type='password' name='pass' placeholder='Hasło' style='font-size:25px;padding:10px;width:80%'><br><br>");
    client.println("<input type='submit' value='OTWÓRZ DRZWI' class='btn'></form>");
    client.println("</body></html>");
    client.stop();
  }
}