#include "ui.h"
#include "config.h"
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SH110X.h>

namespace ui {
namespace {

Adafruit_SH1106G oled(128, 64, &Wire, -1);
bool have_oled = false;

bool link_ok = false;
bool tamper_open = false;
uint8_t pin_len = 0;
char msg[33] = "";
uint32_t msg_until = 0;      // 0 = tekst na stałe
uint32_t last_draw = 0;
uint8_t anim = 0;

// brzęczyk: prosty nieblokujący automat (ten sam styl co silnik dźwięków
// w centralce — sterowanie wyłącznie przez millis(), zero delay())
uint16_t bz_on = 0, bz_off = 0;
uint8_t bz_left = 0;
bool bz_state = false;
uint32_t bz_next = 0;

void drawIdle() {
  oled.setTextSize(1);
  oled.setCursor(2, 2);
  oled.print("CTRLABLE");
  oled.drawFastHLine(0, 12, 128, SH110X_WHITE);

  if (msg[0]) {
    // tekst z centralki — łamiemy na dwie linie po 21 znakach (6 px/znak)
    char l1[22] = "", l2[22] = "";
    size_t n = strlen(msg);
    if (n <= 21) {
      strncpy(l1, msg, 21);
    } else {
      int cut = 21;
      for (int i = 21; i > 0; i--) {
        if (msg[i] == ' ') { cut = i; break; }
      }
      strncpy(l1, msg, cut);
      strncpy(l2, msg + cut + (msg[cut] == ' ' ? 1 : 0), 21);
    }
    oled.setTextSize(1);
    oled.setCursor(max(0, (128 - (int)strlen(l1) * 6) / 2), 28);
    oled.print(l1);
    if (l2[0]) {
      oled.setCursor(max(0, (128 - (int)strlen(l2) * 6) / 2), 40);
      oled.print(l2);
    }
  } else if (pin_len > 0) {
    oled.setCursor(28, 16);
    oled.print("Wpisz PIN:");
    oled.setTextSize(2);
    oled.setCursor(10, 30);
    for (uint8_t i = 0; i < pin_len && i < 9; i++) oled.print('*');
    oled.print('_');
    oled.setTextSize(1);
    oled.setCursor(4, 52);
    oled.print("#=OK  *=Czyszczenie");
  } else {
    // ekran spoczynkowy: kłódka + zachęta
    oled.fillRoundRect(14, 28, 22, 18, 2, SH110X_WHITE);
    oled.fillCircle(25, 35, 2, SH110X_BLACK);
    oled.drawFastVLine(25, 37, 5, SH110X_BLACK);
    oled.drawCircleHelper(25, 28, 7, 1 | 2, SH110X_WHITE);
    oled.drawFastVLine(18, 28, 4, SH110X_WHITE);
    oled.drawFastVLine(32, 28, 4, SH110X_WHITE);
    oled.setTextSize(1);
    oled.setCursor(48, 26);
    oled.print("Przyloz karte");
    oled.setCursor(48, 38);
    oled.print("lub wpisz PIN");
  }

  oled.drawFastHLine(0, 53, 128, SH110X_WHITE);
  oled.setCursor(2, 56);
  if (tamper_open) {
    // sabotaż jest ważniejszy niż stan łącza — miga, żeby zwrócić uwagę
    if (anim % 2) oled.print("!! SABOTAZ !!");
  } else {
    oled.print(link_ok ? "POLACZONY" : "BRAK POLACZENIA");
  }
}

}  // namespace

void begin() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, I2C_FREQ);
  have_oled = oled.begin(I2C_ADDR_OLED, true);
  if (have_oled) {
    oled.setTextColor(SH110X_WHITE);
    oled.clearDisplay();
    oled.setCursor(2, 2);
    oled.print("CTRLABLE panel");
    oled.setCursor(2, 14);
    oled.print("fw " FW_VERSION);
    oled.display();
  }
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
}

bool oledPresent() { return have_oled; }

void setLinkOk(bool ok) { link_ok = ok; }
void setTamper(bool open) { tamper_open = open; }

void showText(const char *txt, uint8_t seconds) {
  strncpy(msg, txt, sizeof(msg) - 1);
  msg[sizeof(msg) - 1] = 0;
  msg_until = seconds ? millis() + (uint32_t)seconds * 1000UL : 0;
  last_draw = 0;   // wymuś przerysowanie
}

void clearText() {
  msg[0] = 0;
  msg_until = 0;
  last_draw = 0;
}

void setPinLength(uint8_t n) {
  if (n != pin_len) {
    pin_len = n;
    last_draw = 0;
  }
}

void beep(uint16_t on_ms, uint16_t off_ms, uint8_t repeat) {
  bz_on = on_ms; bz_off = off_ms;
  bz_left = repeat ? repeat : 1;
  bz_state = true;
  bz_next = millis() + on_ms;
  digitalWrite(PIN_BUZZER, HIGH);
}

void beepStop() {
  bz_left = 0;
  bz_state = false;
  digitalWrite(PIN_BUZZER, LOW);
}

void tick() {
  uint32_t now = millis();

  // --- brzęczyk ---
  if (bz_left && (int32_t)(now - bz_next) >= 0) {
    if (bz_state) {
      digitalWrite(PIN_BUZZER, LOW);
      bz_state = false;
      bz_left--;
      bz_next = now + bz_off;
      if (!bz_left) { /* koniec sekwencji */ }
    } else if (bz_left) {
      digitalWrite(PIN_BUZZER, HIGH);
      bz_state = true;
      bz_next = now + bz_on;
    }
  }

  // --- tekst czasowy z centralki ---
  if (msg_until && (int32_t)(now - msg_until) >= 0) clearText();

  // --- rysowanie ---
  if (!have_oled) return;
  if (now - last_draw < UI_TICK_MS) return;
  last_draw = now;
  anim++;
  oled.clearDisplay();
  drawIdle();
  oled.display();
}

}  // namespace ui
