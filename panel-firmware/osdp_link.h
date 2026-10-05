// Warstwa RS-485 + OSDP PD (LibOSDP, Apache-2.0).
// Panel jest urządzeniem peryferyjnym (PD): zgłasza zdarzenia, wykonuje
// komendy. Decyzję o otwarciu drzwi podejmuje WYŁĄCZNIE centralka (CP).
#pragma once
#include <Arduino.h>

namespace link485 {

void begin();
void tick();

// zdarzenia wysyłane do centralki
bool sendCard(const uint8_t *uid, uint8_t len);
bool sendKey(char key);
bool sendTamper(bool open);

bool online();                 // czy centralka odpytuje nas na bieżąco
bool secure();                 // czy kanał jest szyfrowany (Secure Channel)
uint32_t lastActivityMs();

int  address();
uint32_t baud();

}  // namespace link485
