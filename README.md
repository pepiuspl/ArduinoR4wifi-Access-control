# CTRLABLE Node — Full System Documentation

**Last updated:** July 29, 2026

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
      │ Tailscale VPN (private dev access)
      │ or access.ctrlable.pl (public, toggle Access List)
      ▼
  Metro Bundler (port 8081)
```

- **ESP32** connects directly to `192.168.0.199:3000` on LAN (not through nginx)
- **Phone app** connects via HTTPS through `node.ctrlable.pl` → NPM → `192.168.0.199:3000`
- **Metro bundler** (Expo dev server) runs on port 8081 — reachable either via **Tailscale** (private, daily use) or via **access.ctrlable.pl** (public, demos only — toggle Access List)

---

## 2. Infrastructure

### 2.1 Machines

| Name | IP | Role | OS |
|---|---|---|---|
| smartlock-backend | 192.168.0.199 (privileged LXC on Proxmox host, container ID varies) | Node.js server, PostgreSQL, pm2 | Debian |
| Proxy | 192.168.0.102 | Nginx Proxy Manager (Docker) | Debian/Docker host |
| ESP32 | 192.168.0.76 (DHCP) | Access control hardware | ESP32 DevKit |
| Router | 192.168.0.1 | Gateway, DHCP, port forwarding | — |

### 2.2 Domains (DNS A records → 185.101.191.76)

| Domain | Points to | Purpose |
|---|---|---|
| `node.ctrlable.pl` | NPM → 192.168.0.199:3000 | API server (HTTPS) — always public |
| `access.ctrlable.pl` | NPM → 192.168.0.199:8081 | Expo Metro bundler — public **only when demoing**, otherwise use Tailscale |

**DNS registrar note:** enter only `node` or `access` as the record name — the registrar appends `.ctrlable.pl` automatically.

### 2.3 Port forwarding (Router → LAN)

| External port | Internal destination | Purpose |
|---|---|---|
| 80 | 192.168.0.102:80 | NPM HTTP (Let's Encrypt challenges) |
| 443 | 192.168.0.102:443 | NPM HTTPS (covers both node. and access. subdomains) |

### 2.4 Nginx Proxy Manager

**URL:** `http://192.168.0.102:81`
**Container name:** `nginx-proxy-manager`
**Data path on host:** `/opt/npm/data` (mounted to `/data` in container)

#### Proxy host: node.ctrlable.pl

- Scheme: `http`, Forward: `192.168.0.199:3000`, Websockets: ON
- SSL: Let's Encrypt, Force SSL ON
- Advanced tab:
```nginx
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header Host $host;

limit_req zone=api burst=10 nodelay;
```

#### Rate limiting config (inside NPM container, http-level directive)

```bash
docker exec nginx-proxy-manager cat /etc/nginx/conf.d/rate_limit.conf
# Should contain: limit_req_zone $binary_remote_addr zone=api:10m rate=120r/m;
```
If missing after a container restart, recreate it:
```bash
docker exec nginx-proxy-manager sh -c 'echo "limit_req_zone \$binary_remote_addr zone=api:10m rate=120r/m;" > /etc/nginx/conf.d/rate_limit.conf'
docker exec nginx-proxy-manager nginx -t && docker exec nginx-proxy-manager nginx -s reload
```
120r/m (not the original 30r/m) — the app polls `/api/data` every 2s; a lower limit causes false "offline" flickers from 429 responses.

#### Proxy host: access.ctrlable.pl

- Scheme: `http`, Forward: `192.168.0.199:8081`, Websockets: ON
- SSL: Let's Encrypt, Force SSL ON
- **Access List:** toggle between "Publicly Accessible" (for demos) and a Basic Auth list named `CTRLABLE Dev` (default/idle state) — see §6.2

**KNOWN ISSUE:** deleting/recreating a proxy host in NPM sometimes fails to write the `.conf` file. After recreating, verify:
```bash
docker exec nginx-proxy-manager grep -rl "node.ctrlable" /data/nginx/
```
If nothing found: `docker restart nginx-proxy-manager`.

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
| System logs (master) | `/var/log/smartlock/smartlock_system.log` | All server activity |
| System logs (categorized) | `/var/log/smartlock/{entries,connections,updates,security,provisioning,mail}/YYYY-MM-DD.log` | Same events, split by category and day — see §3.6 |

### 3.2 Environment file (.env)

```
JWT_SECRET=<random 64-char hex>
GITHUB_PAT=<GitHub personal access token with repo scope>
DB_PASSWORD=<PostgreSQL password for admin user>
DB_USER=admin
DB_NAME=smartlock_db
EXPO_TOKEN=<Expo access token for EAS CLI>
```

Loaded with `require('dotenv').config({ path: '/opt/smartlock-server/.env', override: true })` — the `override: true` is essential; without it pm2's cached env wins over `.env` and credential rotation silently fails. Change credentials in `.env` only, then `pm2 restart ctrlable-server` — no need to touch pm2 directly.

### 3.3 pm2 processes

| Name | Command | Working dir |
|---|---|---|
| ctrlable-server | `node server.js` | `/opt/smartlock-server` |
| ctrlable-app | `npx expo start --lan --port 8081` | `/opt/smartlock-server/app` |

**pm2 binary:** `/usr/local/bin/pm2`. **systemd service `ctrlable-server` is DISABLED** — pm2 only.

#### Common commands
```bash
pm2 list
pm2 restart ctrlable-server         # picks up .env changes automatically
pm2 logs ctrlable-server --lines 20 --nostream
pm2 env 0
pm2 save                            # persist across reboot
pm2 resurrect                       # restore after reboot

# Full app restart with hostname (choose ONE mode — see §3.7)
pm2 delete ctrlable-app
kill -9 $(lsof -t -i :8081) 2>/dev/null
sleep 3
cd /opt/smartlock-server/app
REACT_NATIVE_PACKAGER_HOSTNAME=<hostname> \
  pm2 start "npx expo start --lan --port 8081" --name ctrlable-app
pm2 save
```

### 3.4 Known server.js bugs that recur on file replacement

These bugs have reappeared **multiple times** across separate edits/uploads — always grep for them after any server.js change:

```bash
# 1. Infinite loops — must have i++ not i)
grep "for (let i = 0; i <" /opt/smartlock-server/server.js
# every hit must show: i++) {

# 2. JWT regex — must capture full token
grep "header.match" /opt/smartlock-server/server.js
# must show: (.+)  NOT  (.)

# 3. Keypad brute force counter — must increment
grep "keypadAttempts\[mac\].count" /opt/smartlock-server/server.js
# must show: count++  NOT  count;

# 4. PIN validation regex — must allow multi-digit
grep "test(String(pin))" /opt/smartlock-server/server.js
# must show: /^\d+$/  NOT  /^\d$/

# 5. getFactoryAdminPassword — server algorithm MUST match firmware exactly
grep -A6 "function getFactoryAdminPassword" /opt/smartlock-server/server.js
# must use hashNum += (accumulate), and return "CN" + first 5 digits of hashNum
# (NOT hashNum = (overwrite), NOT a raw 6-digit number — these are two different
#  historical bugs that both broke WiFi-change / local hardware auth)

# 6. MAC declaration order in /api/auth/keypad
# const { pin } and const mac MUST be declared BEFORE the `if (!mac || !pin)` check

# 7. GitHub response chunking
grep "githubRes.on('data'" /opt/smartlock-server/server.js
# must show: data += chunk   NOT   data = chunk

# 8. dotenv override
grep "override" /opt/smartlock-server/server.js
# must show: override: true
```

### 3.5 API Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /api/auth/login | None | Login, returns JWT |
| POST | /api/auth/register | None | Create account |
| POST | /api/auth/forgot_password | None | Step 1 of password reset — sends 6-digit code |
| POST | /api/auth/verify_reset_code | None | Step 2 — validates code |
| POST | /api/auth/confirm_password_reset | None | Step 3 — sets new password |
| GET | /api/data | JWT | Dashboard data (lock state, users, logs, devices list) |
| GET | /api/unlock | JWT | Trigger remote unlock (`?mac=` optional, multi-device) |
| GET | /api/toggle_learn | JWT | Toggle RFID learning mode (`?mac=` optional) |
| POST | /api/settings/wifi | JWT | Change ESP32 WiFi credentials (`mac` in body, optional) |
| POST | /api/settings/password | JWT | Change app account password |
| GET | /api/firmware/version | None | Check latest GitHub release |
| GET | /api/ota/push | JWT | Download .bin from GitHub and push OTA |
| GET | /api/hardware/poll | None | ESP32 heartbeat/command poll |
| GET | /api/hardware/log | None | ESP32 remote log submission |
| GET | /api/hardware/log_button | None | ESP32 button press log |
| POST | /api/auth/keypad | None | ESP32 keypad PIN verification (enforces schedule/expiry/max-uses) |
| POST | /api/auth/save_push_token | JWT | Save Expo push notification token |
| POST | /api/keypad/add | JWT | Add new keypad PIN (supports guest-code fields) |
| POST | /api/keypad/delete | JWT | Delete keypad PIN |
| POST | /api/keypad/toggle_active | JWT | Enable/disable keypad PIN |
| POST | /api/keypad/rename | JWT | Rename keypad PIN |
| POST | /api/keypad/update_schedule | JWT | Set/update day+time access window for a PIN |
| GET | /api/devices/list | JWT | List all devices on the account (multi-device) |
| POST | /api/devices/rename | JWT | Rename a device |
| POST | /api/devices/remove | JWT | Remove a device from the account |
| POST | /api/user/rename | JWT | Rename an RFID card holder |
| POST | /api/user/toggle_active | JWT | Enable/disable an RFID card |
| POST | /api/user/delete | JWT | Delete an RFID card |
| GET | /api/lock/download-firmware | None | ESP32 downloads .bin during OTA |

---

## 4. Database (PostgreSQL)

### 4.1 Connection

```bash
psql -h localhost -U admin smartlock_db    # interactive, works as root via /root/.pgpass
psql_smartlock_db                          # alias, same thing
psql -h localhost -U admin smartlock_db -c "SELECT * FROM devices;"
```
`.pgpass` at `/root/.pgpass`: `localhost:5432:smartlock_db:admin:<password>` (chmod 600). Locale warnings are harmless (`export LC_ALL=C` is already in `~/.bashrc`).

### 4.2 Key tables

```sql
-- Devices (multi-device: one account can own many rows here)
SELECT * FROM devices;
-- mac_address, account_id, device_name, last_known_ip, operational_mode, firmware_version, last_heartbeat

-- Accounts
SELECT id, email, push_token FROM accounts;

-- Keypad PINs (now includes scheduling + guest-code columns)
SELECT * FROM keypad_pins;
-- id, account_id, name, pin_hash, active, created_at,
-- schedule_enabled, schedule_days (bitmask, bit0=Sun..bit6=Sat), schedule_start_minutes, schedule_end_minutes,
-- expires_at, max_uses, use_count, is_guest_code
-- (columns auto-migrated on server startup via runSchemaMigrations(), safe to re-run)

-- Event log (now consistently tagged with [Node: MAC] in the message text)
SELECT * FROM system_events ORDER BY event_time DESC LIMIT 20;
```

### 4.3 Common fixes

```bash
# Fix device IP (if overwritten by gateway/hairpin-NAT IP)
psql -h localhost -U admin smartlock_db -c "UPDATE devices SET last_known_ip = '192.168.0.76' WHERE mac_address = 'D4:E9:F4:78:08:60';"
```

---

## 5. Firmware (ESP32)

### 5.1 Pin assignments (current — post relay-swap and tamper install)

| Function | GPIO | Notes |
|---|---|---|
| RELAY_PIN | 13 | **Active-HIGH module** (2nd/current relay board) — HIGH energizes/unlocks, LOW deenergizes/locks. Boot state = LOW immediately. |
| BUTTON_PIN | 33 | INPUT_PULLUP |
| LED_GREEN | 25 | |
| LED_RED | 26 | |
| BUZZER_PIN | 27 | |
| RST_PIN (RFID) | 4 | |
| SS_PIN (RFID) | 5 | |
| TAMPER_PIN | 32 | INPUT_PULLUP, `TAMPER_INSTALLED = true` (physically installed) |
| KP_ROW1 | 14 | INPUT_PULLUP |
| KP_ROW2 | 15 | INPUT_PULLUP |
| KP_ROW3 | 34 | INPUT_PULLUP (limited internal pull-up on input-only pin; external 10kΩ recommended) |
| KP_ROW4 | 35 | same as ROW3 |
| KP_COL1 | 16 | OUTPUT |
| KP_COL2 | 17 | OUTPUT |
| KP_COL3 | 12 | OUTPUT |
| I2C SDA (OLED) | 21 | `Wire.begin()` default |
| I2C SCL (OLED) | 22 | `Wire.begin()` default — do **not** wire anything else here |

**Relay history note:** the relay module was swapped mid-project. The *old* module was active-LOW (LOW=unlock). The *current/new* module is active-HIGH (HIGH=unlock). If you ever swap hardware again, `relayActivate()`/`relayDeactivate()` and the boot-state line in `setup()` all need to flip together — see git history or the mid-2026 conversation log for both variants.

### 5.2 Server connection

```cpp
#define PROXMOX_SERVER "node.ctrlable.pl"
#define PROXMOX_PORT   3000
```
Resolves via hairpin NAT through the router. UFW on the server allows port 3000 from `192.168.0.1` (hairpin NAT), `192.168.0.76` (direct), `192.168.0.102` (NPM).

### 5.3 OTA update workflow

1. Build `.bin`: Arduino IDE → Sketch → Export Compiled Binary (or let GitHub Actions auto-build on push)
2. On GitHub: **do not edit an existing release's assets** — GitHub keeps the same `release.id`, which the OTA system uses for comparison, so silently editing assets means devices never see the "update available" state. Instead: delete the release (not the tag), then "Draft a new release" selecting the **existing tag**, attach the new `.bin`. This gives a fresh `release.id` while keeping the version string unchanged — lets you ship hotfixes under a stable version number like `v3.0.1` forever.
3. Delete cached binary on server: `rm /opt/smartlock-server/updates/lock_*.bin`
4. Trigger from app: Firmware screen → Check for updates → Update

### 5.4 EEPROM layout

| Address | Data |
|---|---|
| 0 | totalCards |
| 10+ | User structs (RFID uid + name) |
| 260 | ssid |
| 292 | pass |
| 324 | owner_email |
| 480 | installedReleaseId (GitHub release ID of currently flashed firmware — loaded at boot so device doesn't re-trigger OTA after every restart) |

### 5.5 Compiling

- Board: ESP32 Dev Module, core 3.3.10
- `server.available()` deprecated → use `server.accept()`
- `setConnectTimeout()` renamed → `setConnectionTimeout()`
- GPIO 34/35 input-only, `gpio 85 no internal PU` warning is harmless
- GitHub Actions auto-compiles on push and creates a release tagged `build-<commit-hash>` — the app hides this raw string from users (shows generic "update available" text), server logs still capture it for debugging

### 5.6 Provisioning page security

The ESP32's local setup page (`http://192.168.4.1` when in `CTRLABLE_SETUP` AP mode) **no longer pre-fills the saved WiFi password** in the form — this was leaking the home WiFi password in plaintext to anyone who connected to the setup AP. Verify this fix is present if you ever regenerate the firmware from an old backup:
```cpp
// Should NOT include value='...' with the saved password:
client.println("<input type='password' id='wifi_pass' name='p' placeholder='Password' required>");
```

---

## 6. Mobile App (React Native / Expo)

### 6.1 Key configuration

| Setting | Value |
|---|---|
| backendUrl | `https://node.ctrlable.pl` (always) |
| SDK | Expo 54 |
| Project ID | `f64190e7-e6e5-425c-8767-5638bddde8d7` |
| Bundle ID | `com.pepiuspl.ctrlablelock` |
| Expo account | `pepiuspl` |

**CRITICAL:** verify `backendUrl` has `https://` after every App.js regeneration:
```bash
grep "backendUrl.*useState" /opt/smartlock-server/app/App.js
```

### 6.2 Two ways to reach Metro (dev bundler) — pick one at a time

Metro can only advertise **one** hostname in its manifest at a time (`REACT_NATIVE_PACKAGER_HOSTNAME`). You cannot have both Tailscale and public access active simultaneously without restarting Metro.

**A) Tailscale (default/daily use — private, no exposure)**
```bash
tailscale status   # note your server's 100.x.x.x address
pm2 delete ctrlable-app
kill -9 $(lsof -t -i :8081) 2>/dev/null
cd /opt/smartlock-server/app
REACT_NATIVE_PACKAGER_HOSTNAME=100.72.102.40 \
  pm2 start "npx expo start --lan --port 8081" --name ctrlable-app
pm2 save
```
On phone: install Tailscale app, log into same account, then Safari → `exp://100.72.102.40:8081`.

**B) Public via access.ctrlable.pl (demos only)**
```bash
pm2 delete ctrlable-app
kill -9 $(lsof -t -i :8081) 2>/dev/null
cd /opt/smartlock-server/app
REACT_NATIVE_PACKAGER_HOSTNAME=access.ctrlable.pl \
  EXPO_PACKAGER_PROXY_URL=https://access.ctrlable.pl \
  pm2 start "npx expo start --lan --port 8081" --name ctrlable-app
pm2 save
```
**Both env vars are required** — without `EXPO_PACKAGER_PROXY_URL`, the manifest advertises `:8081` explicitly, which isn't reachable through NPM's port-443-only public path, causing a blank screen / "could not connect" on the demo device.

Before demoing: NPM → `access.ctrlable.pl` → Details → Access List → **Publicly Accessible**.
After demoing: switch Access List back to `CTRLABLE Dev` (Basic Auth) to stop leaking the manifest (project ID, bundle identifier, file paths, Expo username) publicly, then switch back to mode A for your own use.

**Note:** Expo Go cannot pass Basic Auth credentials through when fetching the bundle — the auth prompt only protects a browser viewing the raw manifest JSON, it does not let Expo Go authenticate. This is a known limitation, not a bug in our config.

Verify which mode is currently active:
```bash
curl -s https://access.ctrlable.pl | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['launchAsset']['url'])"
```

### 6.3 Dependencies

```bash
cd /opt/smartlock-server/app
npm install --legacy-peer-deps    # ALWAYS use this flag
# NEVER run npm audit fix --force
```

### 6.4 SecureStore

`expo-secure-store` installed but **disabled in Expo Go** (needs native EAS build). Currently falls back to AsyncStorage automatically via the `Storage` wrapper in App.js. Re-enable when you do the native build.

### 6.5 EAS Update (JS bundle publishing — separate from the dev server, publishes to Expo's CDN)

```bash
cd /opt/smartlock-server/app
EXPO_TOKEN=$(grep EXPO_TOKEN /opt/smartlock-server/.env | cut -d= -f2) \
  npx eas-cli update --channel production --message "description" --non-interactive
```
**Known limitation:** Expo Go caches published bundles aggressively with no reliable cache-clear on iOS — users may need to delete and reinstall Expo Go to see a newly published update. For active development, the Tailscale/access.ctrlable.pl dev-server approach (§6.2) is more reliable than EAS Update.

### 6.6 Multi-device support

- App shows a device switcher on the dashboard **only when the account has more than one device** — invisible for single-device installs, zero behavior change.
- Selecting a device in the switcher sets `selectedMac`, which is silently appended to every `executeCommand`/`fetchStatus` call from then on.
- Adding a new physical device requires **no firmware changes** — flash the same `.ino`, provision it via `CTRLABLE_SETUP`, register with the same account email. It appears in the switcher automatically once it polls successfully.
- Rename/remove devices from the switcher modal (✏️ / 🗑️ icons next to each entry).

### 6.7 Keypad scheduling & guest codes

- Adding a PIN offers two modes: **Stały PIN** (permanent) or **👤 Kod gościnny** (guest code with expiry days + optional max-use limit).
- Every PIN (guest or permanent) can additionally have a **📅 Harmonogram** (day-of-week + time-window restriction) set via the calendar icon on its row — independent of whether it's a guest code.
- All enforcement happens server-side in `/api/auth/keypad` — **no firmware changes needed**, since PIN verification was already server-mediated (unlike RFID, which is matched locally on-device from EEPROM and would need firmware changes to support the same scheduling).

---

## 7. Security

### 7.1 Firewall (UFW on smartlock-backend)
```bash
ufw status
# 3000 ALLOW 192.168.0.102 (NPM) / 192.168.0.76 (ESP32 direct) / 192.168.0.1 (hairpin NAT)
# 8081 ALLOW 192.168.0.102 (NPM, for access.ctrlable.pl mode)
# 22   ALLOW 192.168.0.0/24 (SSH from LAN)
```

### 7.2 Fail2ban (on Proxy machine, 192.168.0.102)
Bans IPs hitting 15+ 404s within 5 minutes, 24h ban.
```bash
fail2ban-client status nginx-4xx
```
**KNOWN ISSUE:** jail config must point at the real log path (`/opt/npm/data/logs/*_access.log`, not a Docker volume UUID path) — if fail2ban fails to start with "Have not found any log file for nginx-4xx jail", check `/etc/fail2ban/jail.local` matches this path. Root cause: `docker inspect nginx-proxy-manager` to confirm the actual `/data` bind mount source if it ever changes.

### 7.3 Tailscale (VPN for private remote dev access)
```bash
tailscale status
tailscale up   # if disconnected
```
Runs inside a **privileged** LXC container. Required Proxmox host config for TUN device access (must be set on the **Proxmox host**, not inside the container):
```
# In /etc/pve/lxc/<CTID>.conf on the Proxmox host:
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net dev/net none bind,create=dir
```
Then `pct stop <CTID> && pct start <CTID>`. Without this, tailscaled fails with `/dev/net/tun does not exist`.

### 7.4 Rate limiting
120 req/min per IP (raised from an initial 30r/m which caused false "offline" states from the app's own 2s polling interval). Config split across NPM Advanced tab (`limit_req`) and `/etc/nginx/conf.d/rate_limit.conf` inside the container (`limit_req_zone`).

### 7.5 IP detection
Server reads real client IP from `X-Real-IP`/`X-Forwarded-For` (set by NPM). Gateway IPs (`192.168.0.1` etc.) are blocked from overwriting `last_known_ip` in the DB — prevents hairpin-NAT traffic from corrupting the device's known LAN address.

### 7.6 Credential rotation
All in `/opt/smartlock-server/.env`. Edit, then `pm2 restart ctrlable-server` — `override: true` in dotenv means no pm2-specific steps needed. For DB password, also run the `ALTER USER` SQL command. For GitHub PAT, revoke old / create new with `repo` scope at github.com/settings/tokens.

---

## 8. Troubleshooting

### 8.1 Server not responding (curl hangs)
```bash
pm2 list   # 100% CPU on ctrlable-server → infinite loop, see §3.4 item 1
pm2 restart ctrlable-server
```

### 8.2 App shows "offline" repeatedly
Causes in order of likelihood: (a) nginx rate limit too low → returning 429 (see §7.4), (b) ESP32 WiFi disconnected (`ping -c3 192.168.0.76`), (c) ESP32 loop frozen (power cycle), (d) UFW blocking (§7.1), (e) server crashed.

### 8.3 "Network response was not ok" / app stuck on loading screen
Check for corrupted App.js — this has happened multiple times where entire functions (`fetchStatus`, `executeCommand`, etc.) silently vanished, leaving only their call sites. Symptom: Metro bundles successfully but the app hangs past the splash screen with no visible error, OR `pm2 logs` shows `ReferenceError: Property 'X' doesn't exist`.
```bash
# Quick brace-balance sanity check on the whole file:
python3 -c "
content = open('/opt/smartlock-server/app/App.js').read()
# crude check — strip strings/comments properly for real use
print('braces:', content.count('{'), content.count('}'))
print('parens:', content.count('('), content.count(')'))
"
```
If balanced but the app still hangs, check that `isLoading` actually gets set to `false` somewhere in a mount-time `useEffect`, and that `fetchStatus`, `executeCommand`, `mergeLockState` are all genuinely defined (not just referenced) — grep for `const fetchStatus =` etc.

### 8.4 Port 3000 conflict (EADDRINUSE)
```bash
kill -9 $(lsof -t -i :3000) 2>/dev/null
systemctl stop ctrlable-server 2>/dev/null; systemctl disable ctrlable-server 2>/dev/null
pm2 restart ctrlable-server
```

### 8.5 Port 8081 conflict / Expo tunnel failures
Prefer `--lan` mode over `--tunnel` (ngrok) — the tunnel proved unreliable ("failed to start tunnel", session closures). See §6.2 for the two supported LAN-based modes.
```bash
pm2 delete ctrlable-app; kill -9 $(lsof -t -i :8081) 2>/dev/null; sleep 3
# then restart with one of the two modes in §6.2
```

### 8.6 NPM proxy returns 404 or empty
```bash
docker exec nginx-proxy-manager grep -rl "node.ctrlable" /data/nginx/
# empty → delete and recreate proxy host in NPM, re-add Advanced config, then:
docker restart nginx-proxy-manager
```

### 8.7 OTA serves stale firmware / shows "update available" forever after updating
```bash
rm /opt/smartlock-server/updates/lock_*.bin
pm2 restart ctrlable-server   # re-fetches latest release ID from GitHub on startup
```
Root cause if it recurs: you edited an existing GitHub release's assets instead of creating a fresh release under the same tag — see §5.3.

### 8.8 GitHub API returns 401
```bash
grep GITHUB_PAT /opt/smartlock-server/.env
curl -s -H "Authorization: token <PAT>" https://api.github.com/repos/pepiuspl/ArduinoR4wifi-Access-control/releases/latest | grep tag_name
# "Bad credentials" → regenerate PAT with "repo" scope, update .env, pm2 restart ctrlable-server
```

### 8.9 WiFi change from app does nothing / device doesn't restart
Two independent causes, both fixed but worth re-checking if it regresses:
1. `handleProvisioningServer()` must be called every loop iteration in firmware `loop()`, not only inside the provisioning-mode branch — otherwise the device never reads incoming `/api/save_settings` requests while online.
2. Server's `getFactoryAdminPassword(mac)` **must byte-for-byte match** the firmware's algorithm (`"CN" + first 5 digits of accumulated hash`) — any mismatch causes the ESP32 to silently reject the settings-change request with no error. See §3.4 item 5.

### 8.10 Device IP overwritten to 192.168.0.1
```bash
psql -h localhost -U admin smartlock_db -c "UPDATE devices SET last_known_ip = '192.168.0.76' WHERE mac_address = 'D4:E9:F4:78:08:60';"
```

### 8.11 Buzzer "scratching" sound every ~1 second
Historically traced to phantom keypad reads from GPIO34/35 floating (no true internal pull-up on ESP32 input-only pins) — usually reappears after physical rework near the keypad/OLED/tamper wiring loosens the external pull-up resistors. Check physical connections first; a temporary debug log in `handleKeypress()` (`logKeypadEvent("DBG key=[...]")`) can confirm which key is phantom-firing before you go looking at wiring.

### 8.12 Relay stuck open / stuck closed / fires at boot
Always re-verify against the *current* physical relay module — active-HIGH vs active-LOW behavior differs by module and has been swapped once already in this project (§5.1). Test empirically: bridge the IN pin directly to 3.3V and to GND (bypassing the ESP32) and observe which state fires the relay, then match `relayActivate()`/`relayDeactivate()`/boot-state accordingly — don't assume from a previous session's notes without re-testing if the hardware changed.

---

## 9. Accounts & Credentials Reference

| Service | Account | Where stored |
|---|---|---|
| Expo | pepiuspl | expo.dev login |
| GitHub | pepiuspl | github.com |
| Tailscale | pepiuspl | tailscale.com, shared tailnet with iPhone |
| Email (device) | ctrlablenode@gmail.com | DB accounts table (id=4) |
| PostgreSQL | admin | `/root/.pgpass` and `.env` |

**Primary device:** MAC `D4:E9:F4:78:08:60`, account_id=4, IP `192.168.0.76`

---

## 10. Daily Operations Cheatsheet

```bash
# Check everything is running
pm2 list

# Live logs
pm2 logs ctrlable-server
pm2 logs ctrlable-app

# Database quick access
psql_smartlock_db

# Device status / recent events
psql -h localhost -U admin smartlock_db -c "SELECT mac_address, device_name, last_known_ip, firmware_version, last_heartbeat FROM devices;"
psql -h localhost -U admin smartlock_db -c "SELECT event_time, message FROM system_events ORDER BY event_time DESC LIMIT 10;"

# Or by category (post-scaling, once you have several devices):
tail -50 /var/log/smartlock/entries/$(date +%F).log

# Test server health
curl -s https://node.ctrlable.pl/api/hardware/poll?mac=test

# Test with auth
TOKEN=$(curl -s -X POST https://node.ctrlable.pl/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ctrlablenode@gmail.com","password":"YOUR_PASSWORD"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('token','MISSING'))")
curl -s https://node.ctrlable.pl/api/data -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# Push OTA update
rm -f /opt/smartlock-server/updates/lock_*.bin
pm2 restart ctrlable-server
# then trigger from app

# Publish EAS JS bundle update
cd /opt/smartlock-server/app
EXPO_TOKEN=$(grep EXPO_TOKEN /opt/smartlock-server/.env | cut -d= -f2) \
  npx eas-cli update --channel production --message "description" --non-interactive

# Switch dev-server mode (see §6.2 for full commands)
tailscale status                       # → mode A (private, default)
# vs. toggle Access List in NPM        # → mode B (public, demo only)
```
