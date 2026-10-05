#include "osdp_link.h"
#include "config.h"
#include "ui.h"
#include <Preferences.h>
#include <osdp.h>
#include "driver/uart.h"

namespace link485 {
namespace {

osdp_t *pd_ctx = nullptr;
HardwareSerial bus(RS485_UART_NUM);
Preferences nvs;

int   pd_addr = OSDP_PD_ADDRESS_DEFAULT;
uint32_t pd_baud = OSDP_BAUD_DEFAULT;
uint8_t scbk[16];
bool have_scbk = false;

uint32_t last_rx = 0;          // ostatni bajt z magistrali
bool link_up = false;

// --- kanał: LibOSDP woła te trzy funkcje, reszta to zwykły UART ----------
int ch_send(void *data, uint8_t *buf, int len) {
  // DE przełącza sprzętowo sterownik UART-a w trybie RS485 half-duplex,
  // więc tu nie ruszamy żadnego pinu — inaczej łatwo o wyścig i ucięty bajt.
  return bus.write(buf, len);
}

int ch_recv(void *data, uint8_t *buf, int maxlen) {
  int n = 0;
  while (bus.available() && n < maxlen) {
    buf[n++] = (uint8_t)bus.read();
  }
  if (n) last_rx = millis();
  return n;
}

void ch_flush(void *data) {
  while (bus.available()) bus.read();
}

// --- komendy z centralki --------------------------------------------------
int on_command(void *arg, struct osdp_cmd *cmd) {
  switch (cmd->id) {
  case OSDP_CMD_TEXT: {
    char txt[OSDP_CMD_TEXT_MAX_LEN + 1];
    uint8_t n = cmd->text.length;
    if (n > OSDP_CMD_TEXT_MAX_LEN) n = OSDP_CMD_TEXT_MAX_LEN;
    memcpy(txt, cmd->text.data, n);
    txt[n] = 0;
    // control_code 1/2 = na stałe, 3/4 = czasowo (temp_time w sekundach)
    bool temporary = (cmd->text.control_code == OSDP_CMD_TEXT_CC_TEMPORARY_NO_WRAP ||
                      cmd->text.control_code == OSDP_CMD_TEXT_CC_TEMPORARY_WRAP);
    ui::showText(txt, temporary ? (cmd->text.temp_time ? cmd->text.temp_time : 2) : 0);
    return 0;
  }
  case OSDP_CMD_BUZZER:
    if (cmd->buzzer.control_code == OSDP_CMD_BUZZER_CC_OFF ||
        cmd->buzzer.control_code == OSDP_CMD_BUZZER_CC_NO_TONE) {
      ui::beepStop();
    } else {
      // on_count/off_count są w jednostkach 100 ms
      ui::beep(cmd->buzzer.on_count * 100, cmd->buzzer.off_count * 100,
               cmd->buzzer.rep_count ? cmd->buzzer.rep_count : 1);
    }
    return 0;

  case OSDP_CMD_LED:
    // Panel nie ma diod (są w centralce) — komendę przyjmujemy, żeby nie
    // generować błędów po stronie CP, ale nie ma czego zaświecić.
    return 0;

  case OSDP_CMD_KEYSET:
    // Provisioning klucza Secure Channel: centralka wgrywa go przy pierwszym
    // połączeniu (panel startuje wtedy w install mode). Zapisujemy w NVS,
    // od następnego bootu kanał jest szyfrowany kluczem docelowym.
    if (cmd->keyset.length == 16) {
      nvs.begin("ctrlable", false);
      nvs.putBytes("scbk", cmd->keyset.data, 16);
      nvs.end();
      ui::showText("KLUCZ ZAPISANY", 3);
      return 0;
    }
    return -1;

  case OSDP_CMD_OUTPUT:
    // Panel nie steruje ryglem — to zadanie centralki. Odrzucamy świadomie.
    return -1;

  default:
    return -1;
  }
}

}  // namespace

void begin() {
  nvs.begin("ctrlable", true);
  pd_addr = nvs.getInt("pd_addr", OSDP_PD_ADDRESS_DEFAULT);
  pd_baud = nvs.getUInt("pd_baud", OSDP_BAUD_DEFAULT);
  have_scbk = nvs.getBytesLength("scbk") == 16;
  if (have_scbk) nvs.getBytes("scbk", scbk, 16);
  nvs.end();

  bus.begin(pd_baud, SERIAL_8N1, PIN_RS485_RX, PIN_RS485_TX);
  // Sprzętowy half-duplex: sterownik UART sam podnosi DE na czas nadawania.
  uart_set_pin((uart_port_t)RS485_UART_NUM, PIN_RS485_TX, PIN_RS485_RX,
               PIN_RS485_DE, UART_PIN_NO_CHANGE);
  uart_set_mode((uart_port_t)RS485_UART_NUM, UART_MODE_RS485_HALF_DUPLEX);

  static struct osdp_pd_cap caps[] = {
    { OSDP_PD_CAP_CONTACT_STATUS_MONITORING, 1, 1 },   // sabotaż obudowy
    { OSDP_PD_CAP_CARD_DATA_FORMAT,          1, 0 },   // surowe UID
    { OSDP_PD_CAP_READER_AUDIBLE_OUTPUT,     1, 1 },   // brzęczyk
    { OSDP_PD_CAP_READER_TEXT_OUTPUT,        1, 2 },   // ekran: 2 linie
    { OSDP_PD_CAP_COMMUNICATION_SECURITY,    1, 1 },   // AES-128 Secure Channel
    { OSDP_PD_CAP_READERS,                   1, 1 },
    { (osdp_pd_cap_function_code_e)0, 0, 0 },          // strażnik listy
  };

  static osdp_pd_info_t info;
  memset(&info, 0, sizeof(info));
  info.name = "ctrlable-panel";
  info.baud_rate = pd_baud;
  info.address = pd_addr;
  // Bez klucza w NVS wchodzimy w install mode: centralka może wtedy wgrać
  // klucz komendą KEYSET. Z kluczem wymuszamy szyfrowanie — po provisioningu
  // panel nie rozmawia już otwartym tekstem.
  info.flags = have_scbk ? OSDP_FLAG_ENFORCE_SECURE : OSDP_FLAG_INSTALL_MODE;
  info.id.version = OSDP_PD_VERSION;
  info.id.model = OSDP_PD_MODEL;
  info.id.vendor_code = OSDP_VENDOR_CODE;
  info.id.serial_number = (uint32_t)(ESP.getEfuseMac() & 0xFFFFFFFFULL);
  info.id.firmware_version = 0x000100;   // 0.1.0
  info.cap = caps;
  info.scbk = have_scbk ? scbk : nullptr;

  static struct osdp_channel chan;
  memset(&chan, 0, sizeof(chan));
  chan.data = nullptr;
  chan.send = ch_send;
  chan.recv = ch_recv;
  chan.flush = ch_flush;

  osdp_logger_init("osdp", 3 /* warning */, nullptr);
  pd_ctx = osdp_pd_setup(&chan, &info);
  if (pd_ctx) osdp_pd_set_command_callback(pd_ctx, on_command, nullptr);
}

void tick() {
  if (!pd_ctx) return;
  osdp_pd_refresh(pd_ctx);
  bool up = (millis() - last_rx) < LINK_TIMEOUT_MS;
  if (up != link_up) {
    link_up = up;
    ui::setLinkOk(up);
  }
}

bool sendCard(const uint8_t *uid, uint8_t len) {
  if (!pd_ctx) return false;
  struct osdp_event ev;
  memset(&ev, 0, sizeof(ev));
  ev.type = OSDP_EVENT_CARDREAD;
  ev.cardread.reader_no = 0;
  ev.cardread.format = OSDP_CARD_FMT_RAW_UNSPECIFIED;
  ev.cardread.direction = 0;
  ev.cardread.length = len * 8;          // w formacie RAW długość jest w bitach
  memcpy(ev.cardread.data, uid, len);
  return osdp_pd_submit_event(pd_ctx, &ev) == 0;
}

bool sendKey(char key) {
  if (!pd_ctx) return false;
  struct osdp_event ev;
  memset(&ev, 0, sizeof(ev));
  ev.type = OSDP_EVENT_KEYPRESS;
  ev.keypress.reader_no = 0;
  ev.keypress.length = 1;
  ev.keypress.data[0] = (uint8_t)key;
  return osdp_pd_submit_event(pd_ctx, &ev) == 0;
}

bool sendTamper(bool open) {
  if (!pd_ctx) return false;
  struct osdp_event ev;
  memset(&ev, 0, sizeof(ev));
  ev.type = OSDP_EVENT_STATUS;
  ev.status.type = OSDP_STATUS_REPORT_LOCAL;   // LOCAL = sabotaż + zasilanie
  ev.status.nr_entries = 2;
  ev.status.report[0] = open ? 1 : 0;          // tamper
  ev.status.report[1] = 0;                     // power fail — panel nie mierzy
  return osdp_pd_submit_event(pd_ctx, &ev) == 0;
}

bool online() { return link_up; }

bool secure() {
  if (!pd_ctx) return false;
  uint8_t mask = 0;
  osdp_get_sc_status_mask(pd_ctx, &mask);
  return mask & 0x01;
}

uint32_t lastActivityMs() { return last_rx; }
int address() { return pd_addr; }
uint32_t baud() { return pd_baud; }

}  // namespace link485
