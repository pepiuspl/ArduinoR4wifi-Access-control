// =========================================================================
// CTRLABLE Access — firmware panelu zewnętrznego (ESP32-C3, OSDP PD)
//
// Panel NIE PODEJMUJE ŻADNEJ DECYZJI o otwarciu drzwi. Czyta kartę, PIN
// i sabotaż, wysyła je magistralą RS-485 jako zdarzenia OSDP, a na ekranie
// pokazuje to, co każe mu centralka. Rygiel jest wyłącznie po stronie
// centralki — kto zdejmie panel, dostaje cztery żyły z szyfrowanym OSDP,
// a nie dostęp do zamka.
//
// Pętla jest w całości nieblokująca (millis(), zero delay()) — tak samo jak
// w firmwarze centralki.
// =========================================================================
#include <Arduino.h>
#include "config.h"
#include "ui.h"
#include "io.h"
#include "osdp_link.h"

namespace {

uint8_t pin_digits = 0;              // ile cyfr wpisano (do gwiazdek na ekranie)
uint32_t pin_last_key = 0;

void handleKey(char k) {
  // Panel tylko liczy znaki dla podglądu; treść PIN-u zna wyłącznie centralka,
  // która dostaje każde naciśnięcie osobnym zdarzeniem.
  if (k == '*') {
    pin_digits = 0;
  } else if (k == '#') {
    pin_digits = 0;                  // centralka zweryfikuje i odeśle wynik
  } else if (pin_digits < 12) {
    pin_digits++;
  }
  pin_last_key = millis();
  ui::setPinLength(pin_digits);
  ui::clearText();                   // wpisywanie PIN-u kasuje poprzedni komunikat
  ui::beep(30, 0, 1);                // krótkie potwierdzenie klawisza
  link485::sendKey(k);
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(50);
  Serial.printf("\nCTRLABLE Access panel, fw %s\n", FW_VERSION);

  ui::begin();          // inicjuje też I2C (używa go ekspander)
  io::begin();
  link485::begin();

  Serial.printf("OSDP PD addr=%d baud=%lu | OLED %s | czytnik %s | ekspander %s\n",
                link485::address(), (unsigned long)link485::baud(),
                ui::oledPresent() ? "ok" : "BRAK",
                io::readerPresent() ? "ok" : "BRAK",
                io::expanderPresent() ? "ok" : "BRAK");

  // Stan początkowy sabotażu trzeba zgłosić, zanim centralka zapyta.
  link485::sendTamper(io::tamperOpen());
  ui::setTamper(io::tamperOpen());
}

void loop() {
  link485::tick();     // obsługa protokołu — najpierw, żeby nie gubić ramek
  io::tick();
  ui::tick();

  uint8_t uid[10], len;
  if (io::takeCard(uid, &len)) {
    pin_digits = 0;
    ui::setPinLength(0);
    ui::beep(60, 0, 1);
    if (!link485::sendCard(uid, len)) {
      ui::showText("BRAK POLACZENIA", 2);
    }
  }

  char k = io::takeKey();
  if (k) handleKey(k);

  if (io::tamperChanged()) {
    bool open = io::tamperOpen();
    ui::setTamper(open);
    link485::sendTamper(open);
    if (open) ui::beep(200, 200, 3);
  }

  // Porzucone wpisywanie PIN-u samo znika z ekranu.
  if (pin_digits && millis() - pin_last_key > PIN_ENTRY_TIMEOUT_MS) {
    pin_digits = 0;
    ui::setPinLength(0);
  }
}
