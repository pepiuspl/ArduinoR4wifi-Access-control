#include "panel_cp.h"

#if PANEL_RS485

#include <Preferences.h>
#include <esp_random.h>
#include <osdp.h>
#include "driver/uart.h"

namespace panel {
namespace {

osdp_t *cp_ctx = nullptr;
HardwareSerial bus(2);          // UART2
Preferences nvs;

uint8_t scbk[16];
bool pd_keyed = false;          // czy panel ma już nasz klucz
bool keyset_sent = false;
uint32_t last_rx = 0;
bool link_up = false;
uint32_t sc_since = 0;

// --- kolejki zdarzeń (producent = callback OSDP, konsument = loop()) ------
// Callback OSDP jest wołany z tego samego zadania co osdp_cp_refresh(),
// czyli z loop() — nie ma tu współbieżności i nie trzeba mutexa.
struct CardEv { uint8_t uid[10]; uint8_t len; };
CardEv card_q[4];
volatile uint8_t card_head = 0, card_tail = 0;
char key_q[16];
volatile uint8_t key_head = 0, key_tail = 0;
bool tamper_state = false, tamper_flag = false;

int ch_send(void *data, uint8_t *buf, int len) {
  return bus.write(buf, len);
}

int ch_recv(void *data, uint8_t *buf, int maxlen) {
  int n = 0;
  while (bus.available() && n < maxlen) buf[n++] = (uint8_t)bus.read();
  if (n) last_rx = millis();
  return n;
}

void ch_flush(void *data) {
  while (bus.available()) bus.read();
}

int on_event(void *arg, int pd, struct osdp_event *ev) {
  switch (ev->type) {
  case OSDP_EVENT_CARDREAD: {
    uint8_t n = ev->cardread.length / 8;         // format RAW: długość w bitach
    if (ev->cardread.format == OSDP_CARD_FMT_ASCII) n = ev->cardread.length;
    if (n == 0 || n > 10) return -1;
    uint8_t next = (card_head + 1) % 4;
    if (next == card_tail) return -1;            // kolejka pełna — gubimy odczyt
    memcpy(card_q[card_head].uid, ev->cardread.data, n);
    card_q[card_head].len = n;
    card_head = next;
    return 0;
  }
  case OSDP_EVENT_KEYPRESS: {
    for (int i = 0; i < ev->keypress.length; i++) {
      uint8_t next = (key_head + 1) % 16;
      if (next == key_tail) break;
      key_q[key_head] = (char)ev->keypress.data[i];
      key_head = next;
    }
    return 0;
  }
  case OSDP_EVENT_STATUS: {
    if (ev->status.type == OSDP_STATUS_REPORT_LOCAL && ev->status.nr_entries >= 1) {
      bool open = ev->status.report[0] != 0;
      if (open != tamper_state) { tamper_state = open; tamper_flag = true; }
    }
    return 0;
  }
  default:
    return 0;
  }
}

void loadOrCreateKey() {
  nvs.begin("ctrlable", false);
  size_t have = nvs.getBytesLength("osdp_scbk");
  if (have == 16) {
    nvs.getBytes("osdp_scbk", scbk, 16);
  } else {
    // Klucz powstaje w urządzeniu i nigdy nie opuszcza go inaczej niż
    // komendą KEYSET po kanale chronionym kluczem instalacyjnym.
    esp_fill_random(scbk, sizeof(scbk));
    nvs.putBytes("osdp_scbk", scbk, 16);
  }
  pd_keyed = nvs.getBool("osdp_keyed", false);
  nvs.end();
}

void sendKeyset() {
  if (!cp_ctx) return;
  struct osdp_cmd cmd;
  memset(&cmd, 0, sizeof(cmd));
  cmd.id = OSDP_CMD_KEYSET;
  cmd.keyset.type = 1;            // 1 = SCBK
  cmd.keyset.length = 16;
  memcpy(cmd.keyset.data, scbk, 16);
  if (osdp_cp_submit_command(cp_ctx, 0, &cmd) == 0) {
    keyset_sent = true;
    nvs.begin("ctrlable", false);
    nvs.putBool("osdp_keyed", true);
    nvs.end();
    pd_keyed = true;
    Serial.println("[OSDP] Klucz Secure Channel wgrany do panelu (KEYSET).");
  }
}

}  // namespace

void begin() {
  loadOrCreateKey();

  bus.begin(PANEL_BAUD, SERIAL_8N1, PANEL_RS485_RX, PANEL_RS485_TX);
  // Sprzętowy half-duplex: sterownik UART sam steruje DE na czas nadawania.
  // Ręczne przełączanie pinu w kodzie kończy się uciętym pierwszym bajtem.
  uart_set_pin(UART_NUM_2, PANEL_RS485_TX, PANEL_RS485_RX,
               PANEL_RS485_DE, UART_PIN_NO_CHANGE);
  uart_set_mode(UART_NUM_2, UART_MODE_RS485_HALF_DUPLEX);

  static osdp_pd_info_t info;
  memset(&info, 0, sizeof(info));
  info.name = "panel";
  info.baud_rate = PANEL_BAUD;
  info.address = PANEL_PD_ADDRESS;
  // Panel fabrycznie nowy nie ma jeszcze klucza — wtedy obie strony wchodzą
  // w install mode (klucz domyślny), centralka wgrywa własny klucz komendą
  // KEYSET i od następnego startu kanał jest wymuszenie szyfrowany.
  info.flags = pd_keyed ? OSDP_FLAG_ENFORCE_SECURE : OSDP_FLAG_INSTALL_MODE;
  info.scbk = pd_keyed ? scbk : nullptr;

  static struct osdp_channel chan;
  memset(&chan, 0, sizeof(chan));
  chan.send = ch_send;
  chan.recv = ch_recv;
  chan.flush = ch_flush;

  osdp_logger_init("osdp", 3 /* warning */, nullptr);
  cp_ctx = osdp_cp_setup(&chan, 1, &info);
  if (cp_ctx) {
    osdp_cp_set_event_callback(cp_ctx, on_event, nullptr);
    Serial.printf("[OSDP] CP gotowy: PD %d, %d bps, klucz %s\n",
                  PANEL_PD_ADDRESS, PANEL_BAUD, pd_keyed ? "wgrany" : "INSTALL MODE");
  } else {
    Serial.println("[OSDP] BLAD: nie udalo sie zainicjalizowac CP");
  }
}

void tick() {
  if (!cp_ctx) return;
  osdp_cp_refresh(cp_ctx);

  bool up = (millis() - last_rx) < 5000;
  if (up != link_up) {
    link_up = up;
    Serial.printf("[OSDP] Panel %s\n", up ? "odpowiada" : "MILCZY");
  }

  // Provisioning klucza: gdy panel dogadał się z nami kluczem instalacyjnym,
  // od razu wgrywamy właściwy klucz i zapamiętujemy, że panel jest już nasz.
  if (!pd_keyed && !keyset_sent && secureChannel()) {
    if (!sc_since) sc_since = millis();
    if (millis() - sc_since > 1000) sendKeyset();   // chwila na ustabilizowanie sesji
  }
}

bool takeCard(uint8_t *uid, uint8_t *len) {
  if (card_tail == card_head) return false;
  memcpy(uid, card_q[card_tail].uid, card_q[card_tail].len);
  *len = card_q[card_tail].len;
  card_tail = (card_tail + 1) % 4;
  return true;
}

bool takeKey(char *key) {
  if (key_tail == key_head) return false;
  *key = key_q[key_tail];
  key_tail = (key_tail + 1) % 16;
  return true;
}

bool tamperOpen() { return tamper_state; }

bool tamperChanged() {
  bool f = tamper_flag;
  tamper_flag = false;
  return f;
}

void showText(const String &txt, uint8_t seconds) {
  if (!cp_ctx) return;
  struct osdp_cmd cmd;
  memset(&cmd, 0, sizeof(cmd));
  cmd.id = OSDP_CMD_TEXT;
  cmd.text.reader = 0;
  cmd.text.control_code = seconds ? OSDP_CMD_TEXT_CC_TEMPORARY_WRAP
                                  : OSDP_CMD_TEXT_CC_PERMANENT_WRAP;
  cmd.text.temp_time = seconds;
  cmd.text.offset_row = 1;
  cmd.text.offset_col = 1;
  size_t n = txt.length();
  if (n > OSDP_CMD_TEXT_MAX_LEN) n = OSDP_CMD_TEXT_MAX_LEN;
  cmd.text.length = (uint8_t)n;
  memcpy(cmd.text.data, txt.c_str(), n);
  osdp_cp_submit_command(cp_ctx, 0, &cmd);
}

void beep(uint8_t on_100ms, uint8_t off_100ms, uint8_t count) {
  if (!cp_ctx) return;
  struct osdp_cmd cmd;
  memset(&cmd, 0, sizeof(cmd));
  cmd.id = OSDP_CMD_BUZZER;
  cmd.buzzer.reader = 0;
  cmd.buzzer.control_code = OSDP_CMD_BUZZER_CC_DEFAULT_TONE;
  cmd.buzzer.on_count = on_100ms;
  cmd.buzzer.off_count = off_100ms;
  cmd.buzzer.rep_count = count;
  osdp_cp_submit_command(cp_ctx, 0, &cmd);
}

bool online() { return link_up; }

bool secureChannel() {
  if (!cp_ctx) return false;
  uint8_t mask = 0;
  osdp_get_sc_status_mask(cp_ctx, &mask);
  return mask & 0x01;
}

bool provisioned() { return pd_keyed; }
uint32_t lastSeenMs() { return last_rx; }

String statusJson() {
  String j = "{";
  j += "\"online\":" + String(online() ? "true" : "false") + ",";
  j += "\"secure\":" + String(secureChannel() ? "true" : "false") + ",";
  j += "\"keyed\":" + String(provisioned() ? "true" : "false") + ",";
  j += "\"tamper\":" + String(tamperOpen() ? "true" : "false") + ",";
  j += "\"last_seen_ms\":" + String(last_rx ? (millis() - last_rx) : 0);
  j += "}";
  return j;
}

}  // namespace panel

#else   // PANEL_RS485 == 0 — wariant z peryferiami podłączonymi lokalnie

namespace panel {
void begin() {}
void tick() {}
bool takeCard(uint8_t *, uint8_t *) { return false; }
bool takeKey(char *) { return false; }
bool tamperOpen() { return false; }
bool tamperChanged() { return false; }
void showText(const String &, uint8_t) {}
void beep(uint8_t, uint8_t, uint8_t) {}
bool online() { return false; }
bool secureChannel() { return false; }
bool provisioned() { return false; }
uint32_t lastSeenMs() { return 0; }
String statusJson() { return "{\"enabled\":false}"; }
}  // namespace panel

#endif
