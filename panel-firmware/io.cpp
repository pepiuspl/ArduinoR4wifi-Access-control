#include "io.h"
#include "config.h"
#include <SPI.h>
#include <Wire.h>
#include <MFRC522.h>
#include <Adafruit_MCP23X17.h>

namespace io {
namespace {

MFRC522 rfid(PIN_RFID_SS, PIN_RFID_RST);
Adafruit_MCP23X17 exp_io;
bool have_reader = false;
bool have_exp = false;

// --- karta ---
uint8_t card_uid[10];
uint8_t card_len = 0;
bool card_ready = false;
uint32_t last_reader_poll = 0;
uint8_t last_uid[10];
uint8_t last_uid_len = 0;
uint32_t last_uid_time = 0;

// --- klawiatura ---
// Układ klawiszy: kolumna 1 = 1/4/7/*, kolumna 2 = 2/5/8/0, kolumna 3 = 3/6/9/#.
const char KEYMAP[4][3] = {
  {'1', '2', '3'},
  {'4', '5', '6'},
  {'7', '8', '9'},
  {'*', '0', '#'},
};
const uint8_t COL_PIN[3] = {EXP_PIN_COL1, EXP_PIN_COL2, EXP_PIN_COL3};
const uint8_t ROW_PIN[4] = {EXP_PIN_ROW1, EXP_PIN_ROW2, EXP_PIN_ROW3, EXP_PIN_ROW4};
uint32_t last_scan = 0;
char pending_key = 0;
char held_key = 0;              // klawisz trzymany — zgłaszamy tylko zbocze
uint32_t held_since = 0;

// --- sabotaż ---
bool tamper_state = false;      // true = obudowa otwarta
bool tamper_flag = false;
bool tamper_raw_last = false;
uint32_t tamper_since = 0;

void scanKeypad(uint32_t now) {
  if (!have_exp || now - last_scan < KEYPAD_SCAN_MS) return;
  last_scan = now;

  char found = 0;
  for (uint8_t c = 0; c < 3 && !found; c++) {
    // tylko badana kolumna w dół, pozostałe w stan wysokiej impedancji
    for (uint8_t i = 0; i < 3; i++) {
      exp_io.pinMode(COL_PIN[i], i == c ? OUTPUT : INPUT);
      if (i == c) exp_io.digitalWrite(COL_PIN[i], LOW);
    }
    for (uint8_t r = 0; r < 4; r++) {
      if (exp_io.digitalRead(ROW_PIN[r]) == LOW) { found = KEYMAP[r][c]; break; }
    }
  }
  // kolumny z powrotem w Hi-Z, żeby nie zwierały się przy kilku klawiszach
  for (uint8_t i = 0; i < 3; i++) exp_io.pinMode(COL_PIN[i], INPUT);

  if (found && found != held_key) {
    held_key = found;
    held_since = now;
    pending_key = found;          // zgłaszamy zbocze naciśnięcia
  } else if (!found && held_key && now - held_since > KEYPAD_DEBOUNCE_MS) {
    held_key = 0;                 // puszczony
  }
}

void scanTamper(uint32_t now) {
  if (!have_exp) return;
  bool raw = exp_io.digitalRead(EXP_PIN_TAMPER) == HIGH;  // NC do masy: HIGH = otwarte
  if (raw != tamper_raw_last) {
    tamper_raw_last = raw;
    tamper_since = now;
  } else if (raw != tamper_state && now - tamper_since > TAMPER_DEBOUNCE_MS) {
    tamper_state = raw;
    tamper_flag = true;
  }
}

void pollReader(uint32_t now) {
  if (!have_reader || card_ready || now - last_reader_poll < READER_POLL_MS) return;
  last_reader_poll = now;
  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial()) return;

  uint8_t len = rfid.uid.size > 10 ? 10 : rfid.uid.size;
  bool same = (len == last_uid_len) && memcmp(rfid.uid.uidByte, last_uid, len) == 0;
  if (same && now - last_uid_time < READER_REPEAT_MS) {
    rfid.PICC_HaltA();
    return;                       // ta sama karta trzymana przy czytniku
  }
  memcpy(card_uid, rfid.uid.uidByte, len);
  card_len = len;
  card_ready = true;
  memcpy(last_uid, card_uid, len);
  last_uid_len = len;
  last_uid_time = now;
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}

}  // namespace

void begin() {
  // czytnik
  SPI.begin(PIN_RFID_SCK, PIN_RFID_MISO, PIN_RFID_MOSI, PIN_RFID_SS);
  rfid.PCD_Init();
  delay(20);                                   // tylko w setup(), nie w pętli
  uint8_t v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  have_reader = (v != 0x00 && v != 0xFF);

  // ekspander (I2C zainicjowane już przez ui::begin())
  have_exp = exp_io.begin_I2C(I2C_ADDR_EXP, &Wire);
  if (have_exp) {
    for (uint8_t i = 0; i < 3; i++) exp_io.pinMode(COL_PIN[i], INPUT);
    for (uint8_t i = 0; i < 4; i++) exp_io.pinMode(ROW_PIN[i], INPUT_PULLUP);
    exp_io.pinMode(EXP_PIN_TAMPER, INPUT_PULLUP);
    tamper_raw_last = tamper_state = exp_io.digitalRead(EXP_PIN_TAMPER) == HIGH;
  }
  pinMode(PIN_EXP_INT, INPUT);                 // rezerwa — dziś skanujemy cyklicznie
}

void tick() {
  uint32_t now = millis();
  pollReader(now);
  scanKeypad(now);
  scanTamper(now);
}

bool takeCard(uint8_t *uid, uint8_t *len) {
  if (!card_ready) return false;
  memcpy(uid, card_uid, card_len);
  *len = card_len;
  card_ready = false;
  return true;
}

char takeKey() {
  char k = pending_key;
  pending_key = 0;
  return k;
}

bool tamperOpen() { return tamper_state; }

bool tamperChanged() {
  bool f = tamper_flag;
  tamper_flag = false;
  return f;
}

bool readerPresent() { return have_reader; }
bool expanderPresent() { return have_exp; }

}  // namespace io
