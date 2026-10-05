// Ekran SH1106 + brzęczyk. Panel rysuje UI sam (natychmiastowa reakcja na
// klawisz), a centralka dosyła teksty komendą OSDP TEXT.
#pragma once
#include <Arduino.h>

namespace ui {

void begin();
void tick();                                   // wołać w każdej iteracji loop()

void setLinkOk(bool ok);                       // stan magistrali (ikonka/stopka)
void setTamper(bool open);
void showText(const char *txt, uint8_t seconds); // z komendy OSDP TEXT; 0 = na stałe
void clearText();
void setPinLength(uint8_t n);                  // ile gwiazdek pokazać (0 = ekran spoczynkowy)

void beep(uint16_t on_ms, uint16_t off_ms, uint8_t repeat);  // nieblokująco
void beepStop();
bool oledPresent();

}  // namespace ui
