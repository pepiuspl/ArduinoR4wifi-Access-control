# CTRLABLE Node — Full System Documentation

**Last updated:** August 13, 2026

---

## 1. Architecture Overview

```
┌────────────┐       WiFi (LAN)        ┌───────────────────┐
│   ESP32    │◄──────────────────────►  │  Node.js Server   │
│  Firmware  │   HTTP :3000 direct     │  (smartlock-server)│
│ 192.168.0.76│                         │  192.168.0.199     │
└────────────┘                         └────────┬──────────┘
                                                │ localhost
┌────────────┐     HTTPS via NPM       ┌───────┴──────────┐
│  iPhone    │◄──────────────────────► │  Nginx Proxy Mgr  │
│  Expo Go   │  node.ctrlable.pl:443   │  192.168.0.102    │
│ (App.js)   │                         │  Docker container  │
└────────────┘                         └───────────────────┘
      ▲
      │ Tailscale VPN (private dev access — default, no public exposure)
      ▼
  Metro Bundler (port 8081)
```

- **ESP32 → server:** connects to `node.ctrlable.pl` on port 3000 — see §5.2 for the critical port-forwarding requirement and known security caveat.
- **Phone app → server:** HTTPS through `node.ctrlable.pl` (443) → NPM → `192.168.0.199:3000`. Always public, always encrypted — unaffected by anything below.
- **Dev bundler (Metro):** reached via **Tailscale** (`100.72.102.40:8081`) for daily use. `access.ctrlable.pl` exists as a fallback public path for demos only, normally locked behind Basic Auth — see §6.2.

---

## 2. Infrastructure

### 2.1 Machines

| Name | IP | Role | OS |
|---|---|---|---|
| smartlock-backend | 192.168.0.199 (privileged LXC on Proxmox host) | Node.js server, PostgreSQL, pm2, Tailscale | Debian |
| Proxy | 192.168.0.102 | Nginx Proxy Manager (Docker) | Debian/Docker host |
| ESP32 | 192.168.0.76 (DHCP) | Access control hardware | ESP32 DevKit (WROOM-32) |
| Router | 192.168.0.1 | Gateway, DHCP, port forwarding | — |

### 2.2 Domains (DNS A records → 185.101.191.76)

| Domain | Points to | Purpose |
|---|---|---|
| `node.ctrlable.pl` | NPM → 192.168.0.199:3000 (HTTPS/443) | API server — always public, always HTTPS |
| `node.ctrlable.pl:3000` | Router → 192.168.0.199:3000 (raw HTTP, **no TLS**) | ESP32 firmware connection — see §5.2, security caveat |
| `access.ctrlable.pl` | NPM → 192.168.0.199:8081 | Expo Metro bundler — normally locked (Basic Auth), public only during demos |

### 2.3 Port forwarding (Router → LAN)

| External port | Internal destination | Purpose |
|---|---|---|
| 80 | 192.168.0.102:80 | NPM HTTP (Let's Encrypt challenges) |
| 443 | 192.168.0.102:443 | NPM HTTPS (node./access. subdomains) — **now also the ESP32 path** (TLS, §5.2) |

**Port 3000 is no longer forwarded (removed Aug 13 2026, hardening step #2).** The ESP32 now connects over TLS via `node.ctrlable.pl:443` → NPM → `:3000` (same as the app), so the raw-HTTP internet exposure is gone. Only 80/443 (both → NPM) remain forwarded.

### 2.4 Nginx Proxy Manager

**URL:** `http://192.168.0.102:81` · **Container:** `nginx-proxy-manager` · **Data path:** `/opt/npm/data` (mounted to `/data`)

#### Proxy host: node.ctrlable.pl
- Scheme `http`, Forward `192.168.0.199:3000`, Websockets ON, SSL Let's Encrypt + Force SSL
- Advanced tab:
```nginx
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header Host $host;
limit_req zone=api burst=10 nodelay;
```
- Rate limit config (`/etc/nginx/conf.d/rate_limit.conf` inside container): `limit_req_zone $binary_remote_addr zone=api:10m rate=120r/m;` — raised from an original 30r/m which caused false "offline" states in the app.

#### Proxy host: access.ctrlable.pl
- Scheme `http`, Forward `192.168.0.199:8081`, Websockets ON, SSL Let's Encrypt + Force SSL
- **Access List:** kept on Basic Auth (`CTRLABLE Dev`) permanently. Not toggled anymore — see §6.2 for why.

**KNOWN NPM ISSUE:** recreating a proxy host sometimes fails to write the `.conf` file:
```bash
docker exec nginx-proxy-manager grep -rl "node.ctrlable" /data/nginx/
# empty → docker restart nginx-proxy-manager
```

---

## 3. Server (Node.js)

### 3.1 File locations

| File | Path |
|---|---|
| Server code | `/opt/smartlock-server/server.js` |
| Environment | `/opt/smartlock-server/.env` |
| App code | `/opt/smartlock-server/app/App.js` |
| OTA cache | `/opt/smartlock-server/updates/` |
| Master log | `/var/log/smartlock/smartlock_system.log` |
| Categorized logs | `/var/log/smartlock/{entries,connections,updates,security,provisioning,mail}/YYYY-MM-DD.log` |

### 3.2 Environment file (.env)
```
JWT_SECRET=<random 64-char hex>
GITHUB_PAT=<GitHub PAT with repo scope>
DB_PASSWORD=<PostgreSQL password for admin user>
DB_USER=admin
DB_NAME=smartlock_db
EXPO_TOKEN=<Expo access token for EAS CLI>
LOG_RETENTION_DAYS=90        # optional; auto-purge system_events older than N days (0 = keep forever)
```
Loaded with `override: true` — essential, or pm2's cached env wins over `.env`.

**Data retention (hardening #4, Aug 13 2026):** `purgeExpiredData()` runs on startup and every 24 h — deletes `system_events` older than `LOG_RETENTION_DAYS` (default **90**; set `0` to disable) and stale `device_invites` (>30 days, they hold emails). GDPR data-minimization (Art. 5) + smaller breach blast radius. The **file** logs under `/var/log/smartlock/` are separate — rotate/expire those with OS-level `logrotate` if desired.

### 3.3 pm2 processes
| Name | Command | Working dir |
|---|---|---|
| ctrlable-server | `node server.js` | `/opt/smartlock-server` |
| ctrlable-app | `npx expo start --lan --port 8081` | `/opt/smartlock-server/app` |

```bash
pm2 list
pm2 restart ctrlable-server         # picks up .env changes automatically
pm2 logs ctrlable-server --lines 20 --nostream
pm2 save                            # persist across reboot
```

### 3.4 Known server.js bugs that recur on file replacement
Grep for these after **every** server.js edit — they have each reappeared multiple times across separate sessions:
```bash
grep "for (let i = 0; i <" server.js          # must show i++)
grep "header.match" server.js                  # must show (.+) not (.)
grep "keypadAttempts\[mac\].count" server.js    # must show count++ not count;
grep "test(String(pin))" server.js              # must show /^\d+$/ not /^\d$/
grep -A6 "function getFactoryAdminPassword" server.js  # must use hashNum += (accumulate), return "CN"+first 5 digits
grep "githubRes.on('data'" server.js            # must show data += chunk
grep "override" server.js                       # must show override: true
grep "ORDER BY d\.id\|ORDER BY id ASC" server.js  # must be EMPTY — devices table has no 'id' column, only mac_address. card_credentials DOES have 'id', so hits there are fine.
```

### 3.5 Database table ownership — recurring gotcha
**Every new/altered table in this project has hit "must be owner of table" or "permission denied for schema public" at least once**, because the `admin` DB user isn't always the owner. After any migration failure, check and fix:
```bash
psql_smartlock_db -c "\dt+"    # look for Owner != admin
su -l postgres -c "psql -d smartlock_db -c 'ALTER TABLE <name> OWNER TO admin;'"
su -l postgres -c "psql -d smartlock_db -c 'GRANT CREATE ON SCHEMA public TO admin;'"  # if CREATE TABLE itself fails
```
Tables that have needed this fix so far: `keypad_pins`, `card_credentials`, `system_events`.

### 3.6 API Endpoints (current, full list)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /api/auth/login | — | Login, returns JWT |
| POST | /api/auth/register | — | Create account |
| POST | /api/auth/forgot_password | — | Password reset step 1 |
| POST | /api/auth/verify_reset_code | — | Password reset step 2 |
| POST | /api/auth/confirm_password_reset | — | Password reset step 3 |
| GET | /api/data | JWT | Dashboard data (lock state, users, logs, devices list, keypad_pins w/ schedule fields) |
| GET | /api/unlock | JWT | Remote unlock (`?mac=` optional) |
| GET | /api/toggle_learn | JWT | Toggle RFID learning mode |
| POST | /api/settings/wifi | JWT | Change ESP32 WiFi credentials |
| POST | /api/settings/auto_lock | JWT | Set auto-lock delay in seconds (1–60), takes effect on next poll, no restart |
| GET | /api/firmware/version | — | Latest GitHub release check |
| GET | /api/ota/push | JWT | Push OTA update |
| GET | /api/hardware/poll | — | ESP32 heartbeat/command poll — carries `?email=<owner_email>` every cycle (used for auto-provisioning) and returns command flags incl. `unlock`, `ota`, and `deregister` (owner-triggered EEPROM wipe → CTRLABLE_SETUP) |
| GET | /api/hardware/log | — | ESP32 remote log — **filters/simplifies OTA messages** before storing (raw detail stays in file log only, client sees 3 clean states: connecting/updating/success) |
| GET | /api/hardware/log_button | — | Physical button press log |
| POST | /api/hardware/scan | — | RFID scan reported by ESP32 — **this only logs/queues server-side; the actual unlock decision on RFID is made LOCALLY on the ESP32 from its own EEPROM, see §5.7.** |
| POST | /api/auth/keypad | — | Keypad PIN verification — **fully server-side**, enforces schedule/expiry/max-uses |
| POST | /api/auth/save_push_token | JWT | Save Expo push token |
| POST | /api/keypad/add | JWT | Add PIN to a device (`mac`, defaults to the account's first device; supports `isGuestCode`, `expiresAt`, `maxUses`). Per-device scoping — see §4.1/§6.5 |
| POST | /api/keypad/delete / toggle_active / rename | JWT | Manage PINs (authorized by device access — owner or co-admin) |
| POST | /api/keypad/update_schedule | JWT | Set day/time window for a PIN |
| POST | /api/user/update_schedule | JWT | Set day/time window for an RFID card — **enforced only in `/api/hardware/scan`'s logging/queue decision, NOT in the ESP32's actual local unlock decision. See §5.7 — this is a known limitation.** |
| GET/POST | /api/devices/list, rename | JWT | Multi-device management. (Removal is the hard `deregister_*` flow below — the old soft `remove` endpoint was deleted because the device just re-registered on its next poll.) |
| POST | /api/devices/deregister_request | JWT | Owner-only, **hard** deregister step 1: emails a 6-digit confirm code |
| POST | /api/devices/deregister_confirm | JWT | Owner-only step 2: verifies code → deletes device + all its data → commands the ESP32 to wipe its EEPROM (factory reset) via the poll's `deregister:true` flag, blocking auto-re-registration for 120 s |
| POST | /api/devices/invite, accept_invite | JWT | Multi-admin: owner invites a co-admin by email; email now carries a **link** (`invite_token`) AND a 6-digit `invite_code` fallback. `accept_invite` still redeems the code in-app |
| GET | /invite?token= | — | **Server-rendered HTML** invite-acceptance page (opened from the email link). Shows device name + locked email, collects password + RODO consent |
| POST | /api/devices/accept_via_web | — | Redeems an `invite_token`: creates the account (if new) + `device_shares` row. Never resets an existing account's password |
| GET | /api/devices/shared_users | JWT | Owner-only: list co-admins on a device |
| POST | /api/devices/revoke_share | JWT | Owner-only: remove a co-admin |
| GET | /api/logs/search | JWT | Filtered/paginated log search — `mac`, `category`, `q`, `from`, `to`, `limit`, `offset` |
| POST | /api/user/rename / toggle_active / delete | JWT | Manage RFID cards **in the server's database** — see §5.8 for the EEPROM-sync caveat |

---

## 4. Database (PostgreSQL)

```bash
psql_smartlock_db                          # alias, interactive session as admin
```

### 4.1 Key tables (as of this session)

```sql
-- Devices (multi-device: one account can own many; device_shares grants co-admin access)
SELECT * FROM devices;
-- mac_address (PK, no 'id' column!), account_id, device_name, last_known_ip,
-- operational_mode, firmware_version, last_heartbeat, auto_lock_delay_ms

-- Multi-admin
SELECT * FROM device_shares;   -- id, mac_address, account_id, invited_by, created_at
SELECT * FROM device_invites;  -- id, mac_address, invited_email, invite_code, invite_token, invited_by, expires_at, used

-- Convenience view: which device belongs to whom (owner email via JOIN,
-- no denormalized column to drift). Created once, then: SELECT * FROM devices_owned;
CREATE OR REPLACE VIEW devices_owned AS
SELECT d.mac_address, a.email AS owner_email, d.account_id, d.device_name,
       d.operational_mode, d.firmware_version, d.last_known_ip, d.last_heartbeat
FROM devices d JOIN accounts a ON a.id = d.account_id;

-- Keypad PINs (schedule + guest-code columns)
SELECT * FROM keypad_pins;
-- id, account_id (creator), mac_address (device the PIN belongs to — per-centralka scoping),
-- name, pin_hash, active, created_at,
-- schedule_enabled, schedule_days (bitmask, bit0=Sun..bit6=Sat), schedule_start_minutes, schedule_end_minutes,
-- expires_at, max_uses, use_count, is_guest_code

-- RFID cards (server-side record — see §5.7/5.8 for sync caveats with ESP32's own EEPROM)
SELECT * FROM card_credentials;
-- id, mac_address, holder_name, card_uid, is_active, hardware_slot_idx,
-- schedule_enabled, schedule_days, schedule_start_minutes, schedule_end_minutes

-- Event log (category-tagged: entries/security/provisioning/connections)
SELECT * FROM system_events ORDER BY event_time DESC LIMIT 20;
```

### 4.2 Common fixes
```bash
# Fix device IP (if overwritten by gateway/hairpin-NAT IP)
psql -h localhost -U admin smartlock_db -c "UPDATE devices SET last_known_ip = '192.168.0.76' WHERE mac_address = 'D4:E9:F4:78:08:60';"
```

---

## 5. Firmware (ESP32)

### 5.1 Pin assignments (current)

| Function | GPIO | Notes |
|---|---|---|
| RELAY_PIN | 13 | See §5.6 — **actively driven, no floating.** HIGH=unlock, LOW=lock (idle). |
| BUTTON_PIN | 33 | INPUT_PULLUP |
| LED_GREEN | 25 | |
| LED_RED | 26 | Now also flashes 2× on RFID card denial (unknown or blocked card) |
| BUZZER_PIN | 27 | |
| RST_PIN (RFID) | 4 | |
| SS_PIN (RFID) | 5 | |
| TAMPER_PIN | 32 | INPUT_PULLUP, `TAMPER_INSTALLED = true` |
| KP_ROW1–4 | 14, 15, 34, 35 | INPUT_PULLUP; 34/35 lack true internal pull-up (input-only pins) |
| KP_COL1–3 | 16, 17, 12 | OUTPUT |
| I2C SDA/SCL (OLED) | 21, 22 | `Wire.begin()` default |
| RFID SPI (SCK/MOSI/MISO) | 18, 23, 19 | Default VSPI |

### 5.2 Server connection — architecture note (important)
```cpp
#define PROXMOX_SERVER "node.ctrlable.pl"
#define PROXMOX_PORT   443   // TLS via NPM (was 3000 plain HTTP)
```
**Must stay as the domain name, not a local IP.** Devices will eventually be field-deployed at customer sites, not on this LAN — a hardcoded local IP would only work here and break everywhere else.

**TLS migration — DONE in firmware (Aug 13 2026), pending bench test.** All 8 outbound cloud calls now use `WiFiClientSecure` on port **443** through NPM (same path as the app), replacing plain-HTTP `WiFiClient` on 3000. Server identity is validated against a **pinned root CA** — `ROOT_CA_LE` holds the Let's Encrypt **ISRG Root X1** PEM (embedded) via `setCACert` — MITM-resistant; the LE leaf renews every ~90 days but the root is stable for years. Local AP/provisioning `server.accept()` clients are unchanged. Poll cadence relaxed 1 s → **2.5 s** and read deadlines widened, because a TLS handshake per poll is heavy.
- **Bench-test on the dev device before closing port 3000** (§7.1 / hardening step #2): build + OTA, then verify poll (device "online"), keypad PIN, app unlock, and OTA all work over TLS. Only then remove the router's :3000 forward. A CA/chain problem shows up as every cloud call failing while offline RFID still works.

### 5.3 OTA update workflow
1. Build `.bin` (Arduino IDE or GitHub Actions auto-build on push)
2. **Don't edit an existing release's assets** — delete the release (keep the tag), draft a new one on the same tag, attach the new `.bin`. Keeps version string stable while giving OTA logic a fresh `release.id`.
3. `rm /opt/smartlock-server/updates/lock_*.bin` to clear cache
4. Trigger from app: Firmware screen → Check for updates → Update
5. **Client-facing OTA messages are now simplified** (server-side filtering in `/api/hardware/log`) — users see only 3 states: "Próba nawiązania połączenia...", "Aktualizacja w toku...", "Aktualizacja zakończona pomyślnie ✅". Raw technical detail (byte counts, headers) stays in the file log only.

### 5.4 EEPROM layout
| Address | Data |
|---|---|
| 0 | totalCards |
| 10+ | User structs (RFID uid + name), 10 slots max |
| 220+ | isCardActive flags, one byte per slot |
| 260 | ssid |
| 292 | pass |
| 324 | owner_email |
| 480 | installedReleaseId |

### 5.5 Compiling
- Board: ESP32 Dev Module, core 3.3.10
- `server.available()` deprecated → `server.accept()`
- `setConnectTimeout()` renamed → `setConnectionTimeout()`
- GPIO 34/35 `gpio 85 no internal PU` warning is harmless

### 5.6 Relay — final resolved state (long debugging history, read before touching again)
This relay module (the *current*, physically-swapped-in one — different from the original module used earlier in the project) does **not** behave like a simple active-HIGH or active-LOW device. Multimeter testing across several sessions established:

| Pin IN state | Result |
|---|---|
| Actively driven HIGH (3.3V, `OUTPUT`+`digitalWrite(HIGH)`) | **Unlocks** (final, current config) |
| Actively driven LOW (GND, `OUTPUT`+`digitalWrite(LOW)`) | **Locks** (final, current config, also the idle/boot state) |
| Floating (`pinMode(INPUT)`) | Unreliable — **do not use.** Measured 3.96–4.38V (module's own internal pull-up racing against ESP32's ESD/leakage), not true high-Z. Gave ~20% reliability in testing. |

**Current code (final):**
```cpp
void relayActivate() {   // unlock
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, HIGH);
}
void relayDeactivate() { // lock (idle)
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);
}
// setup(): pinMode(RELAY_PIN, OUTPUT); digitalWrite(RELAY_PIN, LOW); // locked at boot
```
**If reliability issues return** (module swapped again, or this one degrades) — the diagnostic method that worked: multimeter directly on the relay's IN pin (not through the ESP32), testing 3.3V / GND / true-floating (bare wire, disconnected) as three separate conditions, observing the physical lock state (not just the relay board's own LEDs, which can be misleading). If GPIO-level 3.3V logic genuinely can't reach the module's actual energization threshold, the only real fix is a transistor buffer (NPN, base via 1kΩ from GPIO, collector to IN, emitter to GND, pull-up resistor from IN to the relay module's own supply rail) — this was scoped but not implemented, since the active-HIGH/LOW combination above tested as sufficient.

### 5.7 RFID architecture — important correction
**RFID card matching and the unlock decision happen LOCALLY on the ESP32, from its own EEPROM** (`memcmp` against `users[]` array) — **not** server-verified like keypad PINs. `transmitCardPayloadToCloud()` / `/api/hardware/scan` is a fire-and-forget report to the server for logging/push-notification purposes only; it does not gate the physical unlock.

**Practical consequence:** the RFID scheduling feature (`/api/user/update_schedule`, enforced in `/api/hardware/scan`) only affects what the *server* logs and whether it queues a push notification — it does **not** actually block the physical door from opening if the card is a match in EEPROM. True RFID schedule enforcement would require the firmware to either sync schedule data locally and check it before calling `openDoor()`, or change the architecture so the ESP32 waits for server permission before opening (network-dependent, undesirable for offline reliability). **This is an open item, not yet built** — flagged in the missing-features PDF as "requires firmware changes."

### 5.8 EEPROM ↔ database sync — known fragility
Because RFID matching is local (§5.7), the ESP32's own EEPROM card list and the server's `card_credentials` table are **two independent copies** that can drift out of sync — confirmed to happen in practice (a card named "Tomasz 2" existed in EEPROM, fully functional for physical unlock, while completely absent from the server database and invisible in the app).

Causes: learning a card while the server connection is down (EEPROM write succeeds, cloud registration silently fails); deleting/renaming via the app updates the database and *attempts* to relay to the ESP32's local endpoints, but if that relay fails, or if the `idx` used doesn't correspond to the same row on both sides (array-position-based addressing, not a stable ID), the two can end up different.

**To inspect the ESP32's actual EEPROM state directly** (bypasses the cloud/database entirely):
```bash
curl -s 'http://192.168.0.76/api/data?pass=<factory-admin-password>'
```
Compute the factory admin password:
```bash
node -e "
const mac = 'D4:E9:F4:78:08:60'; const salt = 'CTRLABLE_KEY_2026';
const combined = mac.toUpperCase() + salt; let h = 0;
for (let i=0;i<combined.length;i++) h += combined.charCodeAt(i)*(i+1);
console.log('CN'+String(h).substring(0,5));
"
```
To delete a stray local-only EEPROM entry directly:
```bash
curl -s 'http://192.168.0.76/api/delete_user?idx=<N>&pass=<factory-password>'
```
**Recommended clean-resync procedure** if the two get out of sync: clear the EEPROM entries via the local endpoint above, confirm `total:0`, then re-learn the card fresh through the app — this writes to both sides simultaneously and keeps them matched.

### 5.9 RFID antenna gain
```cpp
rfid.PCD_SetAntennaGain(rfid.RxGain_max);  // in forceHardwareRFIDReset(), after PCD_Init()
```
Set to maximum (48dB) to help with weaker tags (keyfobs vs. cards). **Tested and did not resolve** a specific case of a keyfob failing to read behind a keyboard enclosure — that turned out to be a pure physical range limitation (small keyfob antenna + added plastic distance), not a gain/software issue. RC522's antenna is etched directly on the PCB (not a swappable/extendable coil), so options there are limited to: physically reducing the distance (machining a recess in the enclosure), or accepting cards-only in that specific mounting location.

### 5.10 Provisioning page security
The local setup page (`http://192.168.4.1` in `CTRLABLE_SETUP` AP mode) does **not** pre-fill the saved WiFi password anymore:
```cpp
client.println("<input type='password' id='wifi_pass' name='p' placeholder='Password' required>");
```

### 5.11 Deregistration command (owner-triggered EEPROM wipe)
Every poll response is parsed for `"deregister":true` (alongside `unlock`/`ota`/`learn`). When set, the firmware runs the existing `factoryResetSettings()` (writes 0xFF over the whole 512-byte EEPROM + `totalCards=0`) then `ESP.restart()`. On reboot `loadConfiguration()` finds no `0x55` magic at addr 250 → `provisioningMode = true` → `CTRLABLE_SETUP`. This wipes **config data only** (WiFi 260/292, owner_email 324, RFID cards 0/10+/220+) — the program flash is separate and untouched. The server sends `deregister:true` only during the 120 s window after an owner confirms deregistration (§3.6, §6.11), and blocks auto-re-registration during that window so the wiped device can't immediately re-add itself. **This command handling must be present in the deployed firmware** — build + OTA after changing it.

---

## 6. Mobile App (React Native / Expo)

### 6.1 Key configuration
| Setting | Value |
|---|---|
| backendUrl | `https://node.ctrlable.pl` (always — verify after every regeneration) |
| SDK | Expo 54 |
| Project ID | `f64190e7-e6e5-425c-8767-5638bddde8d7` |
| Bundle ID | `com.pepiuspl.ctrlablelock` |

### 6.2 Reaching Metro (dev bundler) — Tailscale is the default, permanently
After repeated confusion/security concerns, this is now settled:

- **Daily use (you):** Tailscale. `REACT_NATIVE_PACKAGER_HOSTNAME=100.72.102.40`, connect via `exp://100.72.102.40:8081` from the Tailscale app. No public exposure, ever.
- **Demos (external viewer, not on your tailnet):** use Tailscale's **node-sharing** feature (login.tailscale.com → Machines → `smartlock-backend` → Share) to grant a specific person temporary access to just this one machine — not full tailnet access. Revoke after.
- **`access.ctrlable.pl` stays locked behind Basic Auth permanently.** It is not toggled for demos anymore — Expo Go can't pass Basic Auth credentials through when fetching the bundle anyway, so it never actually worked for that purpose. Public exposure of this endpoint leaks the Expo project ID, bundle identifier, internal file paths, and Expo username — not secrets, but not meant to be public either.

```bash
pm2 delete ctrlable-app; kill -9 $(lsof -t -i :8081) 2>/dev/null; sleep 3
cd /opt/smartlock-server/app
REACT_NATIVE_PACKAGER_HOSTNAME=100.72.102.40 \
  pm2 start "npx expo start --lan --port 8081" --name ctrlable-app
pm2 save
```

Tailscale on the server itself (privileged LXC) needed this one-time host-side config to get TUN device access:
```
# On the Proxmox HOST, in /etc/pve/lxc/<CTID>.conf:
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net dev/net none bind,create=dir
```
Then `pct stop <CTID> && pct start <CTID>`.

### 6.3 Multi-device support
- The device panel/switcher (`🏠 <name> · Zmień ›`) appears on the dashboard whenever the account has **≥1** device (lowered from ">1" so a single-device owner can also rename/manage it). With multiple devices it also switches the active one.
- Adding a device needs **no firmware changes** — same `.ino`, provisioned via `CTRLABLE_SETUP`, registered to the same account email.
- **Rename** (owner-only): "✏️ Zmień nazwę" on the device card → cross-platform `TextInput` modal (was `Alert.prompt`, iOS-only). Any name, e.g. "Garaż". Server `/api/devices/rename` enforces owner via `account_id`; co-admins don't see the button.
- **Hard removal** is now the deregistration flow in Settings — see §6.11. (The old switcher "🗑️ soft remove" and its `/api/devices/remove` endpoint were both removed: they only deleted the DB row, but the ESP32 re-registers on its next poll because it sends `?email=` every cycle.)

### 6.4 Multiple admins per lock
Access is **per-device**, modeled entirely on `device_shares(mac_address, account_id)` — there is **no global account-level role**. "Owner" vs "admin" is derived from ownership/shares at query time, so one account can own device A and be a co-admin on device B. This is what lets an owner grant an admin access to just one of several centralki.

- **Owner** (`devices.account_id`, set at provisioning via `owner_email`): full control — rename/remove device, invite/revoke co-admins, WiFi settings.
- **Co-admin** (row in `device_shares`, invited by email): can unlock, manage keypad PINs/RFID cards, view logs. Cannot remove the device, change WiFi, or manage other admins (owner-only actions check `devices.account_id` directly).

**Management UI — the "🤝 Zespół (Administratorzy)" screen** (`currentScreen === 'team'`, in the burger menu, online mode only). Always available — **not** gated behind the multi-device switcher (which was the old bug: invite/accept were buried in a modal that only opened with >1 device, so a single-lock owner couldn't invite and a fresh invitee with 0 devices couldn't accept). The screen lists, per owned device: current admins (email + revoke button) and an email invite form (real `TextInput`, not `Alert.prompt` — that is iOS-only).

**Invite flow (link-based):**
1. Owner opens **Zespół**, picks the device card, enters an email → `POST /api/devices/invite`.
2. Server generates `invite_token` (48-hex) + `invite_code` (6-digit fallback), emails a link `PUBLIC_BASE_URL/invite?token=…` (reuses the password-reset SMTP channel).
3. Invitee opens the link → server-rendered page (`GET /invite`, `renderInvitePage()`) with the device name and locked email → sets a password + accepts RODO → `POST /api/devices/accept_via_web` creates the account (if new) and the `device_shares` row. An **existing** account is only granted the share — its password is never reset.
4. Invitee logs into the app → the shared device appears (`/api/data` returns owned + shared devices, each with an `isOwner` flag).

Web-rendered (not a deep link) because the app runs on Expo Go, where custom-scheme deep-linking is unreliable. The in-app "🔑 Mam kod zaproszenia" fallback (6-digit `accept_invite`, for someone who already has an account) is a cross-platform `TextInput` modal reachable from the **Zespół** tab (and the device switcher). The old per-device admin management modal was removed — the Zespół tab is the single management surface now.

### 6.5 Keypad scheduling & guest codes
- Adding a PIN: **Stały PIN** (permanent) or **👤 Kod gościnny** (expiry days + optional max-use limit).
- Any PIN, guest or permanent, can have a **📅 Harmonogram** (day-of-week + time window) via the calendar icon on its row.
- **PINs are per-device** (scoped by `mac_address`, since Aug 13 2026 — §4.1/§9): the list shows the selected centralka's PINs, the 20-PIN limit is per device, and verify checks only that device's PINs. Any account with access to the device (owner **or** co-admin) can add/manage its PINs. Unlike RFID-card schedules, keypad PIN schedules/expiry **are** enforced (server-side).
- Day picker displays Monday-first (Pn/Wt/Śr/Cz/Pt/So/Nd) but the underlying bitmask stays JS `getDay()`-compatible (bit0=Sunday) — display order and storage order are intentionally decoupled via a `DAY_DISPLAY_ORDER` mapping array.
- Card rename now uses the same inline-edit pattern as PIN rename (was previously an `Alert.prompt` popup, inconsistent — fixed).
- **Card scheduling exists in the UI and server, but does not actually gate physical access** — see §5.7. Flagged here so this isn't rediscovered as a "bug" later.

### 6.6 Log filtering/search
- Dashboard log screen has a **⏱ Na żywo / 🔍 Szukaj** toggle.
- Search mode: free-text search, category chips (🚪 Wejścia, ⚠️ Bezpieczeństwo, ⚙️ Konfiguracja, 🔄 Aktualizacje), date range, pagination ("Załaduj więcej").
- Old log entries predating the categorization migration show as uncategorized (grey dot) — expected, not a bug.

### 6.7 Configurable auto-lock delay
- Settings screen → "⏱ Opóźnienie auto-blokady" — numeric input (1–60s) + Save.
- Takes effect on the ESP32's **next poll cycle** (≤1s), no device restart needed.
- Firmware reads `auto_lock_delay` from every poll response; falls back to 3000ms default if absent/invalid.

### 6.8 Push notifications
- Now fire on **successful** unlock via all three paths (keypad PIN, RFID card, remote app unlock) — previously only fired on denied/failed attempts.
- Uses `push_entries` (separate from `push_alarms`, which covers tamper/security events) — independently togglable in app settings.

### 6.9 Dependencies
```bash
cd /opt/smartlock-server/app
npm install --legacy-peer-deps    # ALWAYS use this flag
# NEVER run npm audit fix or npm audit fix --force — breaks Expo deps in this project
```

### 6.10 Running the app locally on a dev machine (Windows)
```
scp -r root@100.72.102.40:/opt/smartlock-server/app "C:\path\to\Server_app"
cd "C:\path\to\Server_app"
npm install --legacy-peer-deps    # ~700 packages is normal; if you see only 1-2, the copy failed
npx expo start
```
Use `cmd.exe`, not PowerShell, if `npm` is blocked by execution policy. Press `w` for web (needs `npx expo install react-dom react-native-web` first), or scan the QR with Expo Go on a phone on the same WiFi.

### 6.11 Device deregistration (hard removal) — Settings → "⚠️ Strefa zaawansowana"
Owner-only, per selected device, two-step with an emailed 6-digit code (the section only renders when the active device's `isOwner` is true). Flow: "🔌 Odłącz i zresetuj centralkę" → `deregister_request` emails a code → enter code → `deregister_confirm`. On confirm the server deletes the device and **all its data** (keypad PINs, cards, logs, co-admin shares) and commands the ESP32 (via poll `deregister:true`) to run `factoryResetSettings()` — wiping **EEPROM only** (WiFi + owner_email + RFID cards); the **firmware/program flash is untouched**. The device reboots into `CTRLABLE_SETUP`; reconnecting means re-provisioning it as new. See §3.6 for the endpoints and §5.11 for the firmware side. **Requires the updated firmware (OTA) to work** — old firmware ignores `deregister` and simply re-registers after the 120 s block.

---

## 7. Security

### 7.1 Firewall (UFW on smartlock-backend)
```bash
ufw status
# 3000 ALLOW from 192.168.0.102   # NPM proxy ONLY
# 8081 ALLOW from 192.168.0.102   # NPM app proxy
# 22   ALLOW from 192.168.0.0/24  # SSH from LAN
```
**Tightened Aug 13 2026 (hardening step #2):** 3000 now accepts **only** from NPM (192.168.0.102). The old `3000 ALLOW from 192.168.0.76 (ESP32)` and `192.168.0.1 (hairpin NAT)` rules were removed, and the router's port-3000 forward was deleted (§2.3) — because the ESP32 now reaches the server over TLS via 443 → NPM → 3000, so nothing needs raw 3000 except NPM itself. The old unencrypted-transport internet exposure is closed.

### 7.2 Fail2ban (on Proxy, 192.168.0.102)
```bash
fail2ban-client status nginx-4xx
```
Jail config must point at `/opt/npm/data/logs/*_access.log` (the real bind-mount path), not a Docker volume UUID.

### 7.3 Tailscale
```bash
tailscale status
```
See §6.2 for the LXC host-side TUN config needed to run it inside this privileged container.

### 7.4 Rate limiting
120 req/min per IP (NPM). See §2.4.

### 7.5 Credential rotation
All in `.env`. Edit, `pm2 restart ctrlable-server` — `override: true` means no other steps needed for the server to pick it up.

---

## 8. Troubleshooting

### 8.1 Server not responding / 100% CPU
```bash
pm2 list   # 100% CPU → infinite loop, see §3.4 item 1
pm2 restart ctrlable-server
```

### 8.2 App shows "offline" repeatedly
Check in order: (a) nginx rate limit (§2.4), (b) ESP32 WiFi (`ping -c3 192.168.0.76`), (c) ESP32 loop frozen (power cycle), (d) UFW, (e) server crashed.

### 8.3 "[NET] Serwer Proxmox nie odpowiada" in Serial Monitor
Means the ESP32 can't reach `PROXMOX_SERVER:PROXMOX_PORT`. Checklist:
1. Is port 3000 actually forwarded on the router to `192.168.0.199:3000`? (§2.3) — this specific failure mode cost an entire debugging session because the forward wasn't in place while `PROXMOX_SERVER` correctly pointed at the domain.
2. Is `pm2` running `ctrlable-server`? `pm2 list`
3. Test from the server itself: `curl -s http://192.168.0.199:3000/api/hardware/poll?mac=test`
4. **Do not** "fix" this by hardcoding a local LAN IP into `PROXMOX_SERVER` — that breaks every field-deployed device that isn't on this specific LAN. The domain name is correct; the router port-forward is what was missing.

Symptom cascade when this is broken: button/keypad/RFID all appear non-functional, because (a) the button-check loop is nested inside the poll's connection-wait block and never executes if `httpCheck.connect()` fails immediately, (b) keypad PIN verification requires a live server round-trip, (c) any server-side unlock queueing (remote unlock from app) never reaches the device.

### 8.4 App/App.js corruption — missing function definitions
Has happened multiple times: entire functions (`fetchStatus`, `executeCommand`, `mergeLockState`, `handleVerifyResetCode`, etc.) silently vanish from App.js while their call sites remain, causing `ReferenceError` or a permanently-stuck loading screen with no visible error. Always verify after any App.js edit:
```bash
python3 -c "
content = open('/opt/smartlock-server/app/App.js').read()
print('braces:', content.count('{'), content.count('}'))
print('parens:', content.count('('), content.count(')'))
"
```
Balanced braces/parens is necessary but not sufficient — also grep for `const fetchStatus =`, `const executeCommand =`, `const mergeLockState =` to confirm they're genuinely *defined*, not just referenced. A mount-time `useEffect` must also call `setIsLoading(false)` or the app hangs on the splash screen forever with a perfectly valid, syntactically-correct file.

### 8.5 Port 3000 / 8081 conflicts
```bash
kill -9 $(lsof -t -i :3000) 2>/dev/null
systemctl stop ctrlable-server 2>/dev/null; systemctl disable ctrlable-server 2>/dev/null
pm2 restart ctrlable-server
```
For 8081/Metro, prefer `--lan` over `--tunnel` (ngrok proved unreliable).

### 8.6 Database migration silently fails ("permission denied")
See §3.5 — table ownership. Always check the migration success count in the startup log after any server.js deploy that touches schema:
```bash
grep "Migration" /var/log/smartlock/smartlock_system.log | tail -3
```
Should read `N/N instrukcji wykonanych pomyślnie` with matching counts — if fewer succeeded than attempted, fix ownership and restart.

### 8.7 OTA serves stale firmware
```bash
rm /opt/smartlock-server/updates/lock_*.bin
pm2 restart ctrlable-server
```
Root cause if recurring: edited an existing GitHub release's assets instead of a fresh release under the same tag (§5.3).

### 8.8 GitHub API 401
```bash
curl -s -H "Authorization: token <PAT>" https://api.github.com/repos/pepiuspl/ArduinoR4wifi-Access-control/releases/latest | grep tag_name
# "Bad credentials" → regenerate PAT (repo scope), update .env, pm2 restart
```

### 8.9 WiFi change from app does nothing
1. `handleProvisioningServer()` must run every `loop()` iteration, not only in provisioning-mode branch.
2. Server's `getFactoryAdminPassword(mac)` must byte-for-byte match firmware's algorithm — any drift silently rejects the request.

### 8.10 Relay stuck open / doesn't respond / flaky
Re-read §5.6 in full before touching code — this was an extensive, multi-session diagnosis. Do not assume the old logic (floating-based) is still correct if the physical relay module has been swapped again; re-run the multimeter test sequence from scratch on real hardware rather than reasoning about it in the abstract, since this module's behavior turned out to be genuinely counter-intuitive (both driven HIGH *and* driven LOW initially appeared to "lock" in one round of testing, but a later, more careful test — wire fully connected through the GPIO the whole time, not manually touched — gave different, and ultimately correct, results). Trust freshly-measured data over remembered conclusions from earlier in the same debugging session.

### 8.11 RFID/keypad "works but door doesn't open" vs "card unrecognized"
First determine which failure mode you're actually looking at — they have completely different causes:
- **Server logs "Odmowa: Nieznany" (unknown card)** → the card genuinely isn't in the *server's* database. Check if it's a stray EEPROM-only card (§5.8).
- **Server logs "Otwarto: <name>" but the physical lock never moves** → this is a relay hardware issue (§5.6), not an RFID/keypad software issue — the access-granted decision and logging both succeeded; only the physical actuation failed.
- **Card works with door but is invisible/undeletable in the app** → EEPROM/database desync (§5.8).

### 8.12 Buzzer "scratching" sound
Historically traced to phantom keypad reads from floating GPIO34/35 (no true internal pull-up on ESP32 input-only pins) — check physical pull-up resistors first if this recurs after any physical rework near the keypad.

### 8.13 App won't start — `Unable to resolve "../../App"` (filename casing)
The Metro/Expo entry (`package.json` main = `expo/AppEntry.js`) does `import App from '../../App'`. On the **case-sensitive Linux server** the entry file MUST be `App.js` (capital A) — the repo stores it lowercase as `app.js`, so deploying that name verbatim breaks the bundle. Symptom is a misleading code frame pointing at the `import App` line (looks like a syntax error, isn't one).
```bash
cd /opt/smartlock-server/app
ls -la App.js app.js          # if only lowercase exists:
cp app.js App.js              # restore the capital-A entry
```
Verify a clean build without a phone (also catches real JS syntax errors as HTTP 500 with file:line):
```bash
curl -s -o /tmp/bundle.txt -w "HTTP %{http_code}\n" "http://localhost:8081/node_modules/expo/AppEntry.bundle?platform=android&dev=true&minify=false"
tail -c 400 /tmp/bundle.txt   # only needed if not 200
```
Going forward, deploy the app entry directly as `App.js`. Also ensure the pm2 process runs `--lan` (never `--tunnel` — ngrok fails; see §6.2/§8.5).

---

## 9. Known Open Items (not yet built — see also the standalone roadmap PDF)

- **RFID schedule/expiry enforcement doesn't actually gate physical access** (§5.7) — the UI and server-side plumbing exist, but the ESP32 makes its own local decision from EEPROM regardless. Needs either firmware-side schedule sync + local enforcement, or an architecture change to make RFID server-mediated like keypad (network-dependency tradeoff).
- ~~**ESP32 firmware transport is unencrypted HTTP**~~ — **migrated to TLS in firmware (Aug 13 2026, §5.2):** `WiFiClientSecure` on 443 through NPM, root-CA pinned. ISRG Root X1 PEM is embedded in `ROOT_CA_LE`. Remaining to fully close this out: (a) bench-test all cloud paths over TLS, (b) then remove the router's port-3000 forward (hardening step #2).
- **EEPROM/database sync has no automatic reconciliation** (§5.8) — currently a manual process if they drift.
- **LittleFS storage migration + local PIN verification** (in progress, Aug 13 2026) — moving cards/PINs/logs off the 512 B EEPROM to LittleFS on internal flash, adding local (offline) PIN verification (PBKDF2 hash) and a two-axis limit model (hardware floor vs per-account license). **LittleFS is in the ESP32 core and the default `esp32:esp32:esp32` partition scheme (used by the arduino-cli CI build) already has a `spiffs` partition — so it deploys via normal OTA, no partition change / USB / re-provision expected.** `partitions.csv` is only a fallback if `LittleFS.begin()` fails the boot self-test. Full model in `LICENSING.md`. Stage 1a done: LittleFS mount + self-test at boot (`initStorage()`), non-invasive.
- **Offline license key (future idea)** — for the "many users, zero cloud, willing to pay" niche: a one-time **signed** license key entered at provisioning that raises the offline-standalone cap **without a server** (firmware validates the signature). Lets the no-cloud brand serve >2-user private clients. Not built; recorded so it isn't lost (`LICENSING.md`).
- ~~**Keypad PINs are account-scoped, not device-scoped**~~ — **FIXED (Aug 13, 2026).** `keypad_pins` now has a `mac_address` column; PINs are scoped per centralka and verify by `mac_address` (any PIN on a device verifies regardless of which account — owner or co-admin — created it). Add/list/manage authorize by device access (owner OR co-admin via `device_shares`). See §4.1.
- Other roadmap items (2FA, data export/deletion, activity-log-triggered features beyond current search, etc.) — see the separate features PDF generated earlier.

---

## 10. Daily Operations Cheatsheet

```bash
# Check everything is running
pm2 list

# Live logs
pm2 logs ctrlable-server
pm2 logs ctrlable-app

# Database
psql_smartlock_db

# Device status
psql -h localhost -U admin smartlock_db -c "SELECT mac_address, device_name, last_known_ip, firmware_version, auto_lock_delay_ms, last_heartbeat FROM devices;"

# Device status WITH owner email (needs the devices_owned view from §4.1)
psql -h localhost -U admin smartlock_db -c "SELECT mac_address, owner_email, device_name, last_known_ip, last_heartbeat FROM devices_owned;"

# Recent events by category
tail -50 /var/log/smartlock/entries/$(date +%F).log

# Test server health
curl -s https://node.ctrlable.pl/api/hardware/poll?mac=test

# Test with auth
TOKEN=$(curl -s -X POST https://node.ctrlable.pl/api/auth/login -H "Content-Type: application/json" -d '{"email":"ctrlablenode@gmail.com","password":"YOUR_PASSWORD"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('token','MISSING'))")
curl -s https://node.ctrlable.pl/api/data -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# Inspect ESP32's own EEPROM directly (bypasses cloud/DB — see §5.8)
curl -s 'http://192.168.0.76/api/data?pass=<factory-admin-password>'

# Push OTA update
rm -f /opt/smartlock-server/updates/lock_*.bin && pm2 restart ctrlable-server
# then trigger from app

# Dev bundler (Tailscale mode, the default)
pm2 delete ctrlable-app; kill -9 $(lsof -t -i :8081) 2>/dev/null; sleep 3
cd /opt/smartlock-server/app
REACT_NATIVE_PACKAGER_HOSTNAME=100.72.102.40 pm2 start "npx expo start --lan --port 8081" --name ctrlable-app
pm2 save
```

## 11. Accounts & Credentials Reference

| Service | Account |
|---|---|
| Expo / GitHub / Tailscale | pepiuspl |
| Email (device account) | ctrlablenode@gmail.com (DB accounts.id=4) |
| PostgreSQL | admin (see `.env` / `.pgpass`) |

**Primary test device:** MAC `D4:E9:F4:78:08:60`, account_id=4, IP `192.168.0.76`
