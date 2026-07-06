# CTRLABLE Node — Full System Documentation

**Last updated:** July 6, 2026
**System version:** v3.0.1

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
```

- **ESP32** connects directly to `192.168.0.199:3000` on LAN (not through nginx)
- **Phone app** connects via HTTPS through `node.ctrlable.pl` → NPM → `192.168.0.199:3000`
- **Metro bundler** (Expo) runs on port 8081, tunneled via ngrok for phone access

---

## 2. Infrastructure

### 2.1 Machines

| Name | IP | Role | OS |
|---|---|---|---|
| smartlock-backend | 192.168.0.199 (container on 192.168.0.205) | Node.js server, PostgreSQL, pm2 | Debian (Proxmox LXC) |
| Proxy | 192.168.0.102 | Nginx Proxy Manager (Docker) | Debian/Docker host |
| ESP32 | 192.168.0.76 (DHCP) | Access control hardware | ESP32 DevKit |
| Router | 192.168.0.1 | Gateway, DHCP, port forwarding | — |

### 2.2 Domains (DNS A records → 185.101.191.76)

| Domain | Points to | Purpose |
|---|---|---|
| `node.ctrlable.pl` | NPM → 192.168.0.199:3000 | API server (HTTPS) |
| `access.ctrlable.pl` | NPM → 192.168.0.199:8081 | Expo Metro bundler |

**DNS registrar note:** enter only `node` or `access` as the record name — the registrar appends `.ctrlable.pl` automatically.

### 2.3 Port forwarding (Router → LAN)

| External port | Internal destination | Purpose |
|---|---|---|
| 80 | 192.168.0.102:80 | NPM HTTP (Let's Encrypt challenges) |
| 443 | 192.168.0.102:443 | NPM HTTPS |

### 2.4 Nginx Proxy Manager

**URL:** `http://192.168.0.102:81`
**Container name:** `nginx-proxy-manager`

#### Proxy host: node.ctrlable.pl

- Scheme: `http`
- Forward Hostname: `192.168.0.199`
- Forward Port: `3000`
- Websockets: ON
- SSL: Let's Encrypt certificate, Force SSL ON
- Advanced tab:
```nginx
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header Host $host;

limit_req zone=api burst=10 nodelay;
```

#### Rate limiting config (inside NPM container)

```bash
# This file was added manually:
docker exec nginx-proxy-manager cat /etc/nginx/conf.d/rate_limit.conf
# Contains: limit_req_zone $binary_remote_addr zone=api:10m rate=30r/m;
```

**KNOWN ISSUE:** When you delete and recreate a proxy host in NPM, the `.conf` file sometimes doesn't get written. After recreating, always verify:
```bash
docker exec nginx-proxy-manager grep -rl "node.ctrlable" /data/nginx/
```
If nothing found, restart NPM: `docker restart nginx-proxy-manager`

Also after recreating, re-add the Advanced tab config and the rate_limit.conf gets orphaned — recreate it:
```bash
docker exec nginx-proxy-manager sh -c 'echo "limit_req_zone \$binary_remote_addr zone=api:10m rate=30r/m;" > /etc/nginx/conf.d/rate_limit.conf'
docker exec nginx-proxy-manager nginx -t
docker exec nginx-proxy-manager nginx -s reload
```

---

## 3. Server (Node.js)

### 3.1 File locations

| File | Path | Purpose |
|---|---|---|
| Server code | `/opt/smartlock-server/server.js` | Main API server |
| Environment | `/opt/smartlock-server/.env` | All secrets and credentials |
| App code | `/opt/smartlock-server/app/App.js` | React Native app |
| App config | `/opt/smartlock-server/app/app.json` | Expo configuration |
| OTA cache | `/opt/smartlock-server/updates/` | Cached firmware .bin files |
| System logs | `/var/log/smartlock/smartlock_system.log` | All server activity |

### 3.2 Environment file (.env)

**Path:** `/opt/smartlock-server/.env`

```
JWT_SECRET=<random 64-char hex>
GITHUB_PAT=<GitHub personal access token with repo scope>
DB_PASSWORD=<PostgreSQL password for admin user>
DB_USER=admin
DB_NAME=smartlock_db
EXPO_TOKEN=<Expo access token for EAS CLI>
```

**dotenv is loaded with `override: true`** — `.env` always wins over pm2 cached env vars. Change credentials in `.env` only, then `pm2 restart ctrlable-server`.

### 3.3 pm2 processes

| ID | Name | Command | Working dir |
|---|---|---|---|
| 0 | ctrlable-server | `node server.js` | `/opt/smartlock-server` |
| 5 | ctrlable-app | `npx expo start --tunnel --port 8081` | `/opt/smartlock-server/app` |

**pm2 binary:** `/usr/local/bin/pm2`

#### Common commands

```bash
# List processes
pm2 list

# Restart server (picks up .env changes automatically)
pm2 restart ctrlable-server

# Restart app
pm2 restart ctrlable-app

# View logs
pm2 logs ctrlable-server --lines 20 --nostream
pm2 logs ctrlable-app --lines 20 --nostream

# Live log tail
pm2 logs ctrlable-server

# Check environment
pm2 env 0

# Save process list (survives reboot)
pm2 save

# Restore after reboot
pm2 resurrect

# Stop everything
pm2 stop all

# Full restart of app (kill stale Metro processes)
pm2 delete ctrlable-app
kill -9 $(lsof -t -i :8081) 2>/dev/null
sleep 3
cd /opt/smartlock-server/app
REACT_NATIVE_PACKAGER_HOSTNAME=access.ctrlable.pl \
  pm2 start "npx expo start --tunnel --port 8081" --name ctrlable-app
pm2 save
```

**systemd service `ctrlable-server` is DISABLED** — only pm2 manages the server. Do not re-enable or it conflicts on port 3000.

### 3.4 Known server.js bugs that recur on file replacement

Every time `server.js` is overwritten (from uploads, regeneration, etc.), verify these fixes are present:

```bash
# 1. Infinite loops — must have i++ not i)
grep "for (let i = 0; i <" /opt/smartlock-server/server.js
# Must show: i++) { ... NOT i) {

# 2. JWT regex — must capture full token
grep "header.match" /opt/smartlock-server/server.js
# Must show: (.+) NOT (.)

# 3. Keypad brute force counter — must increment
grep "keypadAttempts\[mac\].count" /opt/smartlock-server/server.js
# Must show: count++ NOT count;

# 4. MAC declaration order in /api/auth/keypad
# const { pin } and const mac MUST come BEFORE if (!mac || !pin)

# 5. GitHub response chunking
grep "githubRes.on('data'" /opt/smartlock-server/server.js
# Must show: data += chunk NOT data = chunk

# 6. dotenv override
grep "override" /opt/smartlock-server/server.js
# Must show: override: true
```

### 3.5 API Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /api/auth/login | None | Login, returns JWT |
| POST | /api/auth/register | None | Create account |
| GET | /api/data | JWT | Dashboard data (lock state, users, logs) |
| GET | /api/unlock | JWT | Trigger remote unlock |
| POST | /api/settings/wifi | JWT | Change ESP32 WiFi credentials |
| GET | /api/firmware/version | None | Check latest GitHub release |
| GET | /api/ota/push | JWT | Download .bin from GitHub and push OTA |
| GET | /api/hardware/poll | None | ESP32 heartbeat/command poll |
| GET | /api/hardware/log | None | ESP32 remote log submission |
| GET | /api/hardware/log_button | None | ESP32 button press log |
| POST | /api/auth/keypad | None | ESP32 keypad PIN verification |
| POST | /api/auth/save_push_token | JWT | Save Expo push notification token |
| POST | /api/keypad/add | JWT | Add new keypad PIN |
| POST | /api/keypad/delete | JWT | Delete keypad PIN |
| POST | /api/keypad/toggle_active | JWT | Enable/disable keypad PIN |
| POST | /api/keypad/rename | JWT | Rename keypad PIN |
| GET | /api/lock/download-firmware | None | ESP32 downloads .bin during OTA |

---

## 4. Database (PostgreSQL)

### 4.1 Connection

```bash
# Interactive session as root
psql -h localhost -U admin smartlock_db

# Alias (if configured in .bashrc)
psql_smartlock_db

# One-off query
psql -h localhost -U admin smartlock_db -c "SELECT * FROM devices;"
```

**Auth:** `.pgpass` file at `/root/.pgpass` with `localhost:5432:smartlock_db:admin:<password>` (chmod 600).

### 4.2 Key tables

```sql
-- Devices
SELECT * FROM devices;
-- Columns: mac_address, account_id, device_name, last_known_ip, operational_mode, firmware_version, last_heartbeat

-- Accounts
SELECT id, email, push_token FROM accounts;

-- Keypad PINs
SELECT * FROM keypad_pins;
-- Columns: id, account_id, name, pin_hash, active, created_at

-- Event log
SELECT * FROM system_events ORDER BY event_time DESC LIMIT 20;
-- Columns: id, mac_address, event_time, message
```

### 4.3 Common fixes

```bash
# Fix device IP (if overwritten by gateway IP)
psql -h localhost -U admin smartlock_db -c "UPDATE devices SET last_known_ip = '192.168.0.76' WHERE mac_address = 'D4:E9:F4:78:08:60';"

# Check current device state
psql -h localhost -U admin smartlock_db -c "SELECT mac_address, last_known_ip, firmware_version, last_heartbeat FROM devices;"
```

---

## 5. Firmware (ESP32)

### 5.1 Pin assignments

| Function | GPIO | Notes |
|---|---|---|
| RELAY_PIN | 13 | Active LOW fires relay |
| BUTTON_PIN | 33 | INPUT_PULLUP |
| LED_GREEN | 25 | |
| LED_RED | 26 | |
| BUZZER_PIN | 27 | |
| RST_PIN (RFID) | 4 | |
| SS_PIN (RFID) | 5 | |
| TAMPER_PIN | 36 | Input-only, TAMPER_INSTALLED=false |
| KP_ROW1 | 14 | INPUT_PULLUP |
| KP_ROW2 | 15 | INPUT_PULLUP |
| KP_ROW3 | 34 | INPUT_PULLUP (internal pull-up limited on input-only pins) |
| KP_ROW4 | 35 | INPUT_PULLUP (internal pull-up limited on input-only pins) |
| KP_COL1 | 16 | OUTPUT |
| KP_COL2 | 17 | OUTPUT |
| KP_COL3 | 12 | OUTPUT |
| I2C SDA | 21 | OLED display (do NOT use for relay) |
| I2C SCL | 22 | OLED display |

### 5.2 Server connection

```cpp
#define PROXMOX_SERVER "node.ctrlable.pl"
#define PROXMOX_PORT   3000
```

The ESP32 connects to the domain which resolves via hairpin NAT through the router. UFW on the server allows port 3000 from `192.168.0.1` (router/hairpin NAT), `192.168.0.76` (direct), and `192.168.0.102` (NPM).

### 5.3 Relay behavior

The OLD relay module is currently in use (active-LOW, works with 3.3V):
- `relayActivate()` → `digitalWrite(LOW)` → relay fires → door unlocks
- `relayDeactivate()` → `digitalWrite(HIGH)` → relay releases → door locks
- Boot: `digitalWrite(LOW)` immediately in setup → door locked

**NEW relay module (JQC3F-05VDC-C):** requires 5V logic levels — 3.3V from ESP32 is insufficient to release it. Needs NPN transistor interface (BC547: IO13→1kΩ→base, emitter→GND, collector→IN, IN→10kΩ→5V).

### 5.4 OTA update workflow

1. Build `.bin`: Arduino IDE → Sketch → Export Compiled Binary
2. On GitHub: delete the `v3.0.1` release (NOT the tag), create new release selecting existing `v3.0.1` tag, attach new `.bin` as `lock_v3.0.1.bin`
3. Delete cached binary on server: `rm /opt/smartlock-server/updates/lock_v3.0.1.bin`
4. In app: Settings → Check firmware → Download → Push to device
5. Device downloads, flashes, reboots automatically

**IMPORTANT:** Same tag name, new release = new `release.id` from GitHub. The system compares release IDs, not version strings. Editing an existing release's assets does NOT change the ID — you must delete and recreate the release.

### 5.5 EEPROM layout

| Address | Data | Purpose |
|---|---|---|
| 0 | totalCards | Number of RFID cards stored |
| 10+ | User structs | RFID card data (uid + name) |
| 260 | ssid | WiFi SSID |
| 292 | pass | WiFi password |
| 324 | owner_email | Account email |
| 480 | installedReleaseId | GitHub release ID of currently flashed firmware |

### 5.6 Compiling

- IDE: Arduino IDE (or VS Code as editor + Arduino IDE for compile/upload)
- Board: ESP32 Dev Module
- ESP32 core: 3.3.10 (via Espressif board package)
- `server.available()` is deprecated in core 3.x → use `server.accept()`
- `setConnectTimeout()` renamed to `setConnectionTimeout()` in core 3.x
- GPIO 34/35 are input-only — `INPUT_PULLUP` shows warning `gpio 85 no internal PU` (harmless)

### 5.7 GitHub Actions CI

The firmware compiles automatically on push via GitHub Actions (`.github/workflows/`). Compiled `.bin` is attached to releases.

**Repo:** `github.com/pepiuspl/ArduinoR4wifi-Access-control` (private)

---

## 6. Mobile App (React Native / Expo)

### 6.1 Key configuration

| Setting | Value |
|---|---|
| backendUrl | `https://node.ctrlable.pl` |
| SDK | Expo 54 |
| Project ID | `f64190e7-e6e5-425c-8767-5638bddde8d7` |
| Bundle ID | `com.pepiuspl.ctrlablelock` |
| Expo account | `pepiuspl` |

**CRITICAL:** Every time App.js is regenerated or overwritten, verify `backendUrl` has `https://` — it keeps getting lost:
```bash
grep "backendUrl.*useState" /opt/smartlock-server/app/App.js
# Must show: useState('https://node.ctrlable.pl')
```

### 6.2 Dependencies

```bash
cd /opt/smartlock-server/app
npm install --legacy-peer-deps  # ALWAYS use --legacy-peer-deps
# NEVER run npm audit fix --force
```

Key packages: expo ~54.0.0, react-native 0.81.5, expo-secure-store@15.0.8, @expo/ngrok (local), @react-native-async-storage/async-storage

### 6.3 SecureStore

`expo-secure-store` is installed but **disabled in Expo Go** — it requires a native EAS build. Currently falls back to AsyncStorage. The Storage wrapper in App.js handles this automatically:

```javascript
let SecureStore = null; // Disabled: requires native EAS build
```

When you do an EAS native build later, change to:
```javascript
let SecureStore;
try { SecureStore = require('expo-secure-store'); } catch { SecureStore = null; }
```

Key mapping for SecureStore (alphanumeric only):
- `@lock_auth_token` → `lockauthtoken`
- `@lock_local_admin_pass` → `locklocaladminpass`

### 6.4 EAS Update (JS bundle publishing)

Publishes the current App.js bundle to Expo's CDN. Users get updates on next app open.

```bash
cd /opt/smartlock-server/app
EXPO_TOKEN=$(grep EXPO_TOKEN /opt/smartlock-server/.env | cut -d= -f2) \
  npx eas-cli update --channel production --message "description" --non-interactive
```

**Known limitation:** Expo Go caches bundles aggressively with no reliable cache-clear on iOS. Users may need to reinstall Expo Go to get the latest bundle. The tunnel/QR approach (`pm2 start "npx expo start --tunnel"`) is more reliable for development.

### 6.5 app.json

```json
{
  "expo": {
    "name": "CTRLABLE",
    "slug": "ctrlable-lock",
    "version": "1.0.0",
    "orientation": "portrait",
    "icon": "./assets/ctrlable_logo.png",
    "userInterfaceStyle": "dark",
    "ios": {
      "supportsTablet": false,
      "bundleIdentifier": "com.pepiuspl.ctrlablelock",
      "infoPlist": { "ITSAppUsesNonExemptEncryption": false }
    },
    "android": { "adaptiveIcon": { "backgroundColor": "#0f0f11" } },
    "extra": { "eas": { "projectId": "f64190e7-e6e5-425c-8767-5638bddde8d7" } },
    "owner": "pepiuspl"
  }
}
```

---

## 7. Security

### 7.1 Firewall (UFW on smartlock-backend)

```bash
ufw status
# Active rules:
# 3000 ALLOW 192.168.0.102  (NPM proxy)
# 8081 ALLOW 192.168.0.102  (NPM app proxy)
# 3000 ALLOW 192.168.0.76   (ESP32 device)
# 3000 ALLOW 192.168.0.1    (ESP32 via hairpin NAT)
# 22   ALLOW 192.168.0.0/24 (SSH from LAN)
```

#### Adding a new device IP

```bash
ufw allow from <NEW_IP> to any port 3000 comment "New ESP32 device"
```

### 7.2 Fail2ban (on Proxy machine)

Automatically bans IPs that hit 15+ 404s within 5 minutes, ban lasts 24 hours.

```bash
# Check status (run on Proxy machine)
fail2ban-client status
fail2ban-client status nginx-4xx

# Unban an IP
fail2ban-client set nginx-4xx unbanip <IP>
```

### 7.3 Rate limiting

30 requests/minute per IP at nginx level. Configured in:
- `/etc/nginx/conf.d/rate_limit.conf` inside NPM container (the `limit_req_zone` directive)
- NPM Advanced tab for `node.ctrlable.pl` (the `limit_req` directive)

### 7.4 IP detection

Server reads the real client IP from `X-Real-IP` or `X-Forwarded-For` headers (set by NPM). Falls back to `req.socket.remoteAddress`. Gateway IPs (`192.168.0.1`, `10.0.0.1`) are blocked from overwriting `last_known_ip` in the database.

### 7.5 PostgreSQL

Listens on localhost only (`listen_addresses = 'localhost'` in `/etc/postgresql/17/main/postgresql.conf`). Not reachable from the network.

### 7.6 Credential rotation

All credentials are in `/opt/smartlock-server/.env`. To rotate:

```bash
# 1. Edit .env
nano /opt/smartlock-server/.env

# 2. Restart server (dotenv override:true picks up changes automatically)
pm2 restart ctrlable-server

# For DB password, also update PostgreSQL:
psql -h localhost -U admin smartlock_db -c "ALTER USER admin WITH PASSWORD 'NewPassword';"
# Then update DB_PASSWORD in .env and restart

# For GitHub PAT:
# Go to https://github.com/settings/tokens, revoke old, create new with "repo" scope
# Update GITHUB_PAT in .env and restart
```

---

## 8. Troubleshooting

### 8.1 Server not responding (curl hangs)

```bash
pm2 list  # check if ctrlable-server shows 100% CPU → infinite loop
grep "for (let i = 0; i <" /opt/smartlock-server/server.js  # verify i++ not i)
pm2 restart ctrlable-server
```

### 8.2 App shows "offline"

Device hasn't polled within 35 seconds. Causes:
- ESP32 WiFi disconnected: `ping -c3 192.168.0.76`
- ESP32 loop frozen: power cycle (unplug/replug)
- UFW blocking: `ufw status` — verify ESP32 IP or `192.168.0.1` is allowed on port 3000
- Server crashed: `pm2 logs ctrlable-server --lines 10 --nostream`

### 8.3 "Network response was not ok" in app

Token rejected by server. Check:
```bash
grep "header.match" /opt/smartlock-server/server.js  # must be (.+) not (.)
```
If wrong, fix and restart. Then log out and log back in on the phone.

### 8.4 Port 3000 conflict (EADDRINUSE)

```bash
kill -9 $(lsof -t -i :3000) 2>/dev/null
systemctl stop ctrlable-server 2>/dev/null
systemctl disable ctrlable-server 2>/dev/null
pm2 restart ctrlable-server
```

### 8.5 Port 8081 conflict (Expo)

```bash
pm2 delete ctrlable-app
kill -9 $(lsof -t -i :8081) 2>/dev/null
sleep 3
cd /opt/smartlock-server/app
REACT_NATIVE_PACKAGER_HOSTNAME=access.ctrlable.pl \
  pm2 start "npx expo start --tunnel --port 8081" --name ctrlable-app
pm2 save
```

### 8.6 NPM proxy returns 404 or empty

```bash
# Check config file exists
docker exec nginx-proxy-manager grep -rl "node.ctrlable" /data/nginx/
# If empty → delete and recreate proxy host in NPM, then re-add Advanced config
docker restart nginx-proxy-manager
```

### 8.7 OTA serves stale firmware

```bash
rm /opt/smartlock-server/updates/lock_v3.0.1.bin
pm2 restart ctrlable-server
# Trigger OTA from app again
```

### 8.8 GitHub API returns 401

```bash
# Check PAT is correct
grep GITHUB_PAT /opt/smartlock-server/.env
# Test it
curl -s -H "Authorization: token <PAT>" \
  https://api.github.com/repos/pepiuspl/ArduinoR4wifi-Access-control/releases/latest | grep tag_name
# If "Bad credentials" → regenerate PAT at github.com/settings/tokens with "repo" scope
```

### 8.9 Device IP overwritten to 192.168.0.1

Caused by hairpin NAT. The server validates IPs and won't overwrite with gateway addresses. If it happens:
```bash
psql -h localhost -U admin smartlock_db -c "UPDATE devices SET last_known_ip = '192.168.0.76' WHERE mac_address = 'D4:E9:F4:78:08:60';"
```

### 8.10 Let's Encrypt certificate fails

- DNS must be propagated: `nslookup node.ctrlable.pl 8.8.8.8`
- Ports 80/443 must be forwarded to NPM (192.168.0.102)
- Rate limit: max 5 failures per domain per hour — wait before retrying
- Don't set Force SSL until after certificate is issued

### 8.11 Locale warnings in psql

Harmless. Suppress with:
```bash
export LC_ALL=C
```
(Already in `~/.bashrc`)

---

## 9. Accounts & Credentials Reference

| Service | Account | Where stored |
|---|---|---|
| Expo | pepiuspl | expo.dev login |
| GitHub | pepiuspl | github.com |
| Email (device) | ctrlablenode@gmail.com | DB accounts table (id=4) |
| PostgreSQL | admin | `/root/.pgpass` and `.env` |

**Device:** MAC `D4:E9:F4:78:08:60`, account_id=4, IP `192.168.0.76`

---

## 10. Daily Operations Cheatsheet

```bash
# Check everything is running
pm2 list

# View live server logs
pm2 logs ctrlable-server

# View live app logs
pm2 logs ctrlable-app

# Database quick access
psql_smartlock_db

# Check device status
psql -h localhost -U admin smartlock_db -c "SELECT mac_address, last_known_ip, firmware_version, last_heartbeat FROM devices;"

# Check recent events
psql -h localhost -U admin smartlock_db -c "SELECT event_time, message FROM system_events ORDER BY event_time DESC LIMIT 10;"

# Test server health
curl -s https://node.ctrlable.pl/api/hardware/poll?mac=test

# Test with auth
TOKEN=$(curl -s -X POST https://node.ctrlable.pl/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ctrlablenode@gmail.com","password":"YOUR_PASSWORD"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('token','MISSING'))")
curl -s https://node.ctrlable.pl/api/data -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# Push OTA update from CLI
rm /opt/smartlock-server/updates/lock_v3.0.1.bin 2>/dev/null
pm2 restart ctrlable-server
# Then trigger from app

# Publish app update via EAS
cd /opt/smartlock-server/app
EXPO_TOKEN=$(grep EXPO_TOKEN /opt/smartlock-server/.env | cut -d= -f2) \
  npx eas-cli update --channel production --message "description" --non-interactive
```
