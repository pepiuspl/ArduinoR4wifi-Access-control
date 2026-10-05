// =========================================================================
// CTRLABLE Node — strona centralki magistrali RS-485 (OSDP CP)
//
// Centralka jest Control Panelem: odpytuje panel przy drzwiach, odbiera od
// niego zdarzenia (karta, klawisz, sabotaż) i odsyła komendy (tekst na ekran,
// brzęczyk). Decyzja o otwarciu zostaje w access_control.ino — ten moduł
// tylko dostarcza zdarzenia i wyświetla wynik.
//
// Cały moduł jest przełączany kompilacyjnie. Od v3.2.7 domyślna jest **rev 0.3**
// (peryferia w panelu za magistralą); stary układ buduje się jawnie flagą
// -DPANEL_RS485=0 i wtedy wszystkie funkcje tego modułu są puste.
//
// UWAGA: ta domyślna wartość musi zostać TUTAJ i tylko tutaj. Wcześniej taki sam
// blok #ifndef stał również w access_control.ino, więc przy budowaniu bez flagi
// szkic widział PANEL_RS485=1, a panel_cp.cpp — który zna wyłącznie ten nagłówek —
// kompilował się jako puste zaślepki. Firmware linkował się bez błędu, był o 56 KB
// mniejszy i każde wywołanie panel::… nie robiło nic.
// =========================================================================
#pragma once
#include <Arduino.h>

#ifndef PANEL_RS485
#define PANEL_RS485 1
#endif

// Piny magistrali w centralce (PCB rev 0.3) — patrz README §Mapa pinów.
#ifndef PANEL_RS485_TX
#define PANEL_RS485_TX 17    // IO17 -> U4.4 (DI)
#endif
#ifndef PANEL_RS485_RX
#define PANEL_RS485_RX 16    // IO16 <- U4.1 (RO)
#endif
#ifndef PANEL_RS485_DE
#define PANEL_RS485_DE 4     // IO4  -> U4.2 + U4.3 (/RE i DE zwarte)
#endif
#ifndef PANEL_PD_ADDRESS
#define PANEL_PD_ADDRESS 101
#endif
#ifndef PANEL_BAUD
#define PANEL_BAUD 115200
#endif

namespace panel {

void begin();
void tick();                               // wołać w każdej iteracji loop()

// --- zdarzenia od panelu --------------------------------------------------
bool takeCard(uint8_t *uid, uint8_t *len); // true raz na odczytaną kartę
bool takeKey(char *key);                   // true raz na naciśnięty klawisz
bool tamperOpen();                         // ostatni znany stan sabotażu panelu
bool tamperChanged();                      // true raz po każdej zmianie

// --- komendy do panelu ----------------------------------------------------
void showText(const String &txt, uint8_t seconds);  // 0 = do odwołania
void beep(uint8_t on_100ms, uint8_t off_100ms, uint8_t count);

// --- diagnostyka ----------------------------------------------------------
bool online();                             // panel odpowiada na odpytywanie
bool secureChannel();                      // sesja szyfrowana AES-128
bool provisioned();                        // klucz panelu już wgrany
uint32_t lastSeenMs();                     // millis() ostatniej odpowiedzi
String statusJson();                       // do /status i diagnostyki w aplikacji

}  // namespace panel
