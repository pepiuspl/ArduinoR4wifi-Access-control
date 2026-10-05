// =========================================================================
// CTRLABLE Access — panel zewnętrzny, konfiguracja sprzętowa
// Płytka: CTRLABLE-Access-RS485 rev 0.1 (ESP32-C3-MINI-1)
// Wszystkie numery pinów przepisane ze schematu — jeśli zmienisz płytkę,
// zmieniasz TYLKO ten plik.
// =========================================================================
#pragma once
#include <Arduino.h>

// --- magistrala RS-485 do centralki (U3 THVD1410DR) ----------------------
#define PIN_RS485_RX    0     // IO0  <- U3.1 (RO)
#define PIN_RS485_TX    1     // IO1  -> U3.4 (DI)
#define PIN_RS485_DE    4     // IO4  -> U3.2 + U3.3 (/RE i DE zwarte)
#define RS485_UART_NUM  1     // Serial1

// --- I2C: ekran SH1106 + ekspander MCP23017 ------------------------------
// IO2 i IO8 to piny strapujące C3 — muszą być WYSOKIE przy starcie.
// Pull-upy magistrali (R8/R9 4,7 k) załatwiają to same, ale zwarty do masy
// slave I2C zablokuje boot. Przy diagnostyce "panel nie startuje" odłącz
// najpierw ekran i ekspander.
#define PIN_I2C_SCL     2     // IO2
#define PIN_I2C_SDA     8     // IO8
#define I2C_ADDR_OLED   0x3C
#define I2C_ADDR_EXP    0x20  // MCP23017, A0-A2 do masy
#define I2C_FREQ        400000

// --- czytnik RFID (J5, moduł lutowany do goldpina) -----------------------
#define PIN_RFID_SS     10    // IO10
#define PIN_RFID_SCK    6     // IO6
#define PIN_RFID_MOSI   7     // IO7
#define PIN_RFID_MISO   5     // IO5
#define PIN_RFID_RST    3     // IO3
// IRQ czytnika idzie na GPB2 ekspandera (nie zjada pinu MCU) — nieużywane,
// czytnik odpytujemy cyklicznie.

// --- pozostałe ------------------------------------------------------------
#define PIN_EXP_INT     20    // RXD0 <- INTA ekspandera (rezerwa; skanujemy cyklicznie)
#define PIN_BUZZER      21    // TXD0 -> R25 -> baza Q1
// Uwaga: bootloader ROM pisze po TXD0, więc brzęczyk kliknie przy starcie.

// --- klawiatura na ekspanderze -------------------------------------------
// GPA0-GPA2 = kolumny 1-3, GPA3-GPA6 = wiersze 1-4 (patrz README panelu).
#define EXP_PIN_COL1    0
#define EXP_PIN_COL2    1
#define EXP_PIN_COL3    2
#define EXP_PIN_ROW1    3
#define EXP_PIN_ROW2    4
#define EXP_PIN_ROW3    5
#define EXP_PIN_ROW4    6
#define EXP_PIN_TAMPER  8     // GPB0 — mikrostyk NC obudowy panelu

// --- OSDP -----------------------------------------------------------------
// Adres PD i baud można nadpisać w NVS (namespace "ctrlable", klucze
// "pd_addr" / "pd_baud") — dzięki temu ta sama binarka działa na wielu
// panelach bez rekompilacji.
#define OSDP_PD_ADDRESS_DEFAULT  101
#define OSDP_BAUD_DEFAULT        115200
#define OSDP_VENDOR_CODE         0x00435452UL   // "CTR"
#define OSDP_PD_MODEL            1
#define OSDP_PD_VERSION          1

// --- czasy (wszystko na millis(), zero delay() w pętli) -------------------
#define KEYPAD_SCAN_MS      25     // skan matrycy
#define KEYPAD_DEBOUNCE_MS  40
#define READER_POLL_MS      120    // odpytywanie czytnika
#define READER_REPEAT_MS    1500   // ta sama karta nie zgłasza się częściej
#define TAMPER_DEBOUNCE_MS  200
#define UI_TICK_MS          100
#define LINK_TIMEOUT_MS     5000   // brak ruchu na magistrali = "BRAK POLACZENIA"
#define PIN_ENTRY_TIMEOUT_MS 15000 // porzucony PIN znika z ekranu

#define FW_VERSION "0.1.0"
