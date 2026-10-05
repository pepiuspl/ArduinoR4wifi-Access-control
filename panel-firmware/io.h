// Czytnik RFID (SPI) + klawiatura i sabotaż przez ekspander MCP23017 (I2C).
// Wszystko odpytywane cyklicznie w loop() — bez przerwań i bez delay().
#pragma once
#include <Arduino.h>

namespace io {

void begin();
void tick();

// --- karta ---------------------------------------------------------------
// Zwraca true raz na odczyt: uid[] + długość (4, 7 lub 10 bajtów).
bool takeCard(uint8_t *uid, uint8_t *len);

// --- klawiatura ----------------------------------------------------------
// Zwraca pojedynczy znak '0'-'9', '*', '#' albo 0, gdy nic nie naciśnięto.
char takeKey();

// --- sabotaż -------------------------------------------------------------
bool tamperOpen();          // aktualny stan (styk NC rozwarty = sabotaż)
bool tamperChanged();       // true raz po każdej zmianie stanu

bool readerPresent();
bool expanderPresent();

}  // namespace io
