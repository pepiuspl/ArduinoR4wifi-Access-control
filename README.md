# CTRLABLE Node — Full System Documentation

**Last updated:** September 14, 2026 — documentation audit (limits enforcement §3.7, env §3.2, endpoints §3.6, custom PCB rev 0.2 §5.1b, offline licence dormant §5.12); security hardening of 2026-09-11 (§7)

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
| App code | `/opt/smartlock-server/app/App.js` — **capital A**, see the casing trap in §8 |
| App config | `/opt/smartlock-server/app/{app.json,package.json,eas.json}` — versioned in `Server_app/`, **not** shipped by `deploy.sh` (changing them needs `npm install` / a Metro restart, so it stays a deliberate manual step) |
| License generator | `tools/licensekey.js` in the repo → deployed as `/opt/smartlock-server/licensekey.js`. Online codes: run **on the server** (DB). Offline tokens (`offline <MAC> <tier>`): anywhere the licence private key is — no DB needed (§5.12, `LICENSING.md` §3.5) |
| OTA cache | `/opt/smartlock-server/updates/` |
| Master log | `/var/log/smartlock/smartlock_system.log` |
| Categorized logs | `/var/log/smartlock/{entries,connections,updates,security,provisioning,mail}/YYYY-MM-DD.log` |

### 3.1b Deploying from the laptop — `deploy.sh`

`bash deploy.sh` (Windows: Git Bash) ships `Server_app/server.js`, `tools/licensekey.js` and `Server_app/app.js` to the LXC over LAN SSH in **one session** (files as a tar stream on stdin, the remote script base64-inlined — the earlier ControlMaster approach does not work in Git Bash, and this asks for the password once). Before the production `server.js` is replaced the remote side runs `node --check` and greps for the `store[ip].count++` rate-limit fix (§7.4); any failure aborts without touching the running copy. Then it restarts **both** pm2 processes (`ctrlable-server`, `ctrlable-app`) and prints the last `Migration` line from the log. Targets: `server.js` → `/opt/smartlock-server/server.js`, `licensekey.js` → `/opt/smartlock-server/licensekey.js`, `app.js` → `/opt/smartlock-server/app/App.js` (capital A, §8). Override with `DEPLOY_SERVER=` / `DEPLOY_DEST=`. Pushing `Server_app/server.js` to `main` also triggers the GitHub `deploy.yml` (§7.7) — pick one path per change.

### 3.2 Environment file (.env)
```
JWT_SECRET=<random 64-char hex>   # REQUIRED, min. 32 chars — server refuses to start without it (§7.4)
GITHUB_PAT=<GitHub PAT with repo scope>
DB_PASSWORD=<PostgreSQL password for admin user>
DB_USER=admin
DB_NAME=smartlock_db
EXPO_TOKEN=<Expo access token>        # used only by eas-cli on the box — server.js does not read it
PUBLIC_BASE_URL=https://node.ctrlable.pl   # base of the invite link in e-mails (§6.4)
TERMS_URL=https://ctrlable.pl/regulamin.html          # linked from the web invite page
PRIVACY_URL=https://ctrlable.pl/polityka-prywatnosci.html
JWT_EXPIRES=7d               # optional; JWT lifetime (default 7d) — token_version still kills old tokens
CORS_ORIGINS=                # optional; comma-separated allowed origins (empty = same-origin only)
GITHUB_USER=pepiuspl         # optional; release source for OTA (defaults in server.js)
GITHUB_REPO=ArduinoR4wifi-Access-control
DB_HOST=127.0.0.1            # optional (default localhost)
DB_PORT=5432                 # optional
LOG_RETENTION_DAYS=90        # optional; auto-purge system_events older than N days (0 = keep forever)
LEGACY_DEVICE_AUTH=on        # optional; 'off' = reject devices without a device key (§7.2) — set once the fleet is updated
TRUSTED_PROXIES=192.168.0.102  # optional; only these peers may supply X-Real-IP (§7.4)
SERVICE_ACCOUNTS=ctrlablenode@gmail.com  # service account(s), comma-separated — outside the admin limit, expiring share (§7.15)
SERVICE_SHARE_HOURS=48       # optional; how long a service share lives
LOCKED_CREDENTIAL_DAYS=90    # optional; days a package-locked card/PIN is kept before deletion (§3.7)
```
Loaded with `override: true` — essential, or pm2's cached env wins over `.env`. **Log files:** `ops/install-logrotate.sh` (run once on the box as root) installs `/etc/logrotate.d/smartlock` (daily rotation of `smartlock_system.log`, 90 copies, compressed) and a daily cron that deletes categorized logs older than 90 days — the retention promised in the privacy policy. **Mail has no env at all:** nodemailer talks to the local Postfix on `127.0.0.1:25` (sender `"CTRLABLE Node" <info@ctrlable.pl>`; the relay logs in as the single OVH mailbox `node@ctrlable.pl` — OVH accepts any same-domain From, replies to info@ are forwarded to that mailbox); Postfix relays through OVH (`ssl0.ovh.net:587`, SASL password in `/etc/postfix/sasl_passwd`) — see §8.

**Data retention (hardening #4, Aug 13 2026; per-package since Aug 18):** `purgeExpiredData()` runs on startup and every 24 h — deletes `system_events` per device owner according to `accounts.log_retention_days` (COALESCE 15: 15 free / 45 Silver / 90 Gold, `LICENSING.md` §6.0); the global `LOG_RETENTION_DAYS` (default **90**; `0` = disable) only prunes *orphaned* events with no device and stale `device_invites` (>30 days, they hold emails). GDPR data-minimization (Art. 5) + smaller breach blast radius. The **file** logs under `/var/log/smartlock/` are separate — rotate/expire those with OS-level `logrotate` if desired.

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
grep "store\[ip\].count" server.js               # must show count++ — without it NO rate limit works (it was broken until 2026-09-11)
grep "bodyStr += chunk" server.js               # request body must be appended, not overwritten
grep "00:00:00:00:00:00'\] = true" server.js     # must be EMPTY — a wildcard unlock queue opens other customers' doors (§7.3)
grep -c "await requireAuth(req, res)" server.js # requireAuth is async (token_version check) — every call must be awaited
grep "getFactoryAdminPassword\|syncMutationToHardware" server.js  # must be EMPTY — both removed for good (§7.1–7.3)
grep -c "INSERT INTO devices" server.js         # every one MUST include last_known_ip — the column is NOT NULL (created out-of-band);
                                                # an INSERT without it throws, the poll answers 500 and the device never registers (bit us 2026-09-11)
grep "githubRes.on('data'" server.js            # must show data += chunk
grep "override" server.js                       # must show override: true
grep "ORDER BY d\.id\|ORDER BY id ASC" server.js  # must be EMPTY — devices table has no 'id' column, only mac_address. card_credentials DOES have 'id', so hits there are fine.
```
The deploy workflow now fails the deployment itself if `count++` is missing (§7.7).

### 3.5 Database table ownership — recurring gotcha
**Every new/altered table in this project has hit "must be owner of table" or "permission denied for schema public" at least once**, because the `admin` DB user isn't always the owner. After any migration failure, check and fix:
```bash
psql_smartlock_db -c "\dt+"    # look for Owner != admin
su -l postgres -c "psql -d smartlock_db -c 'ALTER TABLE <name> OWNER TO admin;'"
su -l postgres -c "psql -d smartlock_db -c 'GRANT CREATE ON SCHEMA public TO admin;'"  # if CREATE TABLE itself fails
```
Tables that have needed this fix so far: `keypad_pins`, `card_credentials`, `system_events`.

### 3.6 API Endpoints (current, full list)

> **Auth column:** `JWT` = app user token (`Authorization: Bearer`), checked against `accounts.token_version`. `Device key` = `X-Device-Key` header from the centralka (§7.2). `—` = public. Every device-facing endpoint requires the device key; with `LEGACY_DEVICE_AUTH=on` devices that have no key bound yet are still admitted so they can take the OTA.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /api/auth/login | — | Login, returns JWT (10 attempts / 15 min per client IP) |
| POST | /api/auth/register | — | Create account — **now creates it UNVERIFIED**, emails a 6-digit code, returns `{status:"code_sent"}`. Re-registering an unverified email re-sends a fresh code |
| POST | /api/auth/verify_email | — | Redeem the 6-digit code → activates the account, sends the welcome email, returns a JWT (auto-login) |
| POST | /api/auth/forgot_password | — | Password reset step 1 — 5/h per IP **and** per email; response never reveals whether the account exists |
| POST | /api/auth/verify_reset_code | — | Password reset step 2 — the code is **burned after 5 wrong guesses** (§7.4) |
| POST | /api/auth/confirm_password_reset | — | Password reset step 3 — min. 8 chars; bumps `token_version` (logs out every session) |
| POST | /api/settings/password | JWT | Change password — **requires `currentPassword`**, bumps `token_version`, returns a fresh token for the calling phone |
| GET | /api/data | JWT | Dashboard data (lock state, users, logs, devices list, keypad_pins w/ schedule fields, `pendingCommands`). **Card UIDs are no longer returned** (§7.6) |
| GET | /api/unlock | JWT | Remote unlock (`?mac=` optional) |
| GET | /api/toggle_learn | JWT | Toggle RFID learning mode |
| POST | /api/settings/wifi | JWT | **Owner-only.** New WiFi for the centralka, `{mac, wifiSSID, wifiPass}` (≤ 31 chars each) → queued `W` command (§7.3) |
| POST | /api/devices/reset_key | JWT | Owner — or the service account in a **confirmed** service session (§7.15). Clears the bound device key so the board re-binds on its next poll (board swap / key mismatch, §7.2) |
| POST | /api/devices/selftest | JWT | Owner or co-admin: queue a self-test (`G|0`, no relay, no card list); 1/min per device. `GET ?mac=` returns the latest report as plain-language checks + `serviceRecommended` (§7.15) |
| POST | /api/devices/leave | JWT | A co-admin removes their **own** share (service cleans up after itself) |
| POST | /api/service/start, confirm, end | JWT (service acct) | Service session: `start` shows a 6-digit code on the device OLED (`V` command) and pushes the owner; `confirm {code}` proves on-site presence (5 wrong guesses burn it); session valid 60 min (§7.15) |
| POST | /api/service/command | JWT (service, confirmed) | `{mac, action}`: `diagnostics` (`G|1`, with card list), `relay_test` (`G|2`, **opens the door 0.4 s**), `restart` (`R`) |
| GET | /api/service/report | JWT (service, confirmed) | Latest device report: raw values, checks, and the device↔DB card comparison (§5.8) |
| POST | /api/hardware/diag | Device key | Device posts a self-test/diagnostic report (JSON); last 5 kept per device |
| POST | /api/devices/auto_lock | JWT | **Owner-only.** Set that device's auto-lock delay, `{mac, seconds}` (1–60). Stored in `devices.auto_lock_delay_ms`, pushed to the ESP32 in the poll response as `auto_lock_delay` (ms). *(An earlier draft of this doc listed `/api/settings/auto_lock` — that endpoint never existed; see §6.7.)* |
| GET | /api/firmware/version | — | Latest GitHub release check — **cached 5 min** (it used to hit GitHub with the PAT on every call) |
| POST (GET tolerated) | /api/ota/push | JWT | Arm OTA for `{mac}` (or all devices the account can access). Downloads the release `.bin` **and its `.bin.sig`**; refuses unsigned releases (§7.5) |
| GET | /api/hardware/poll (aliases `/api/poll`, `/poll`) | Device key | Heartbeat/command poll. Registers a new MAC to `?email=` (verified accounts only) and binds its key. `?ack=<id>` confirms executed commands; response carries `unlock`, `learn`, `ota`, `deregister`, `auto_lock_delay`, `cmds` (§7.3). No MAC = 400 (no more guessing by IP) |
| GET | /api/hardware/log | Device key | Remote log (max 500 chars) — **filters/simplifies OTA messages** before storing (raw detail stays in the file log) |
| GET | /api/hardware/log_button | Device key | Physical button press log (`?mac=`) |
| POST | /api/hardware/scan (aliases `/api/scan`, `/scan`) | Device key | RFID scan report (log + push) — the unlock decision is LOCAL on the ESP32 (§5.7) |
| POST | /api/hardware/register (aliases `/api/register`, `/register`) | Device key | Card learned in learning mode → `card_credentials` |
| POST | /api/tamper | Device key | Tamper alert |
| GET | /api/lock/download-firmware | Device key | Firmware image, only if OTA is armed for that device; sends `X-Firmware-Signature` |
| POST | /api/auth/keypad | Device key | Keypad PIN verification — **fully server-side**, enforces schedule/expiry/max-uses; 5 attempts / 15 min per device |
| — | /api/device/provision, POST /api/log (and `/log`) | — | **Removed (410).** Unauthenticated, unused by the firmware (§7.2) |
| POST | /api/auth/save_push_token | JWT | Save Expo push token |
| GET | /api/license | JWT | Current entitlements of the account (tier, limits, `license_valid_until`, `expired` flag) — drives the app's "Pakiet i licencja" screen |
| POST | /api/license/redeem | JWT | Redeem an online licence code from `tools/licensekey.js` (`SLVR/GOLD/INDV` + 12 chars); atomic, single-use, extends or sets `license_valid_until` |
| POST | /api/license/keep_selection | JWT | Owner marks which cards/PINs survive a downgrade (`keep_on_downgrade`, §3.7) |
| POST | /api/user/set_owner_card | JWT | Owner designates the owner card/PIN (`is_owner_card` / `is_owner_pin`) — never locked by limit enforcement (§3.7) |
| POST | /api/account/delete_request | JWT | Account deletion step 1: e-mails a 6-digit code (15 min) |
| POST | /api/account/delete_confirm | JWT | Step 2: deletes the account and all its data, factory-resets every owned device (§7.3 wipe), removes co-admin shares, writes an `erasure_requests` tombstone (SHA-256 of the e-mail) |
| GET | /api/account/export | JWT | GDPR export — JSON with account, devices, credentials, shares and events |
| POST | /api/settings/push_preferences | JWT | `{pushEntries, pushAlarms}` — per-category push switches |
| POST | /api/keypad/add | JWT | Add PIN to a device (`mac`, defaults to the account's first device; supports `isGuestCode`, `expiresAt`, `maxUses`). Per-device scoping — see §4.1/§6.5 |
| POST | /api/keypad/delete / toggle_active / rename | JWT | Manage PINs (authorized by device access — owner or co-admin) |
| POST | /api/keypad/update_schedule | JWT | Set day/time window for a PIN |
| POST | /api/user/update_schedule | JWT | Set day/time window for an RFID card → queued `S` command; enforced **locally** by the ESP32 (§5.7) |
| GET/POST | /api/devices/list, rename | JWT | Multi-device management. (Removal is the hard `deregister_*` flow below — the old soft `remove` endpoint was deleted because the device just re-registered on its next poll.) |
| POST | /api/devices/deregister_request | JWT | Owner-only, **hard** deregister step 1: emails a 6-digit confirm code |
| POST | /api/devices/deregister_confirm | JWT | Owner-only step 2: verifies code → deletes device + all its data → commands the ESP32 to wipe its EEPROM (factory reset) via the poll's `deregister:true` flag, blocking auto-re-registration for 120 s |
| POST | /api/devices/invite, accept_invite | JWT | Multi-admin: owner invites a co-admin by email; email now carries a **link** (`invite_token`) AND a 6-digit `invite_code` fallback. `accept_invite` still redeems the code in-app. Since Sep 15 2026 the owner's own e-mail, an address that already holds an active share and one with a pending invite are rejected with 400, and an owner redeeming a code for their own device gets 400 (the invite is marked used) — a self-share used to count against `max_admins`; a migration deletes any existing ones. **An address from `SERVICE_ACCOUNTS` bypasses `max_admins`** and its share is flagged `is_service` + expires after `SERVICE_SHARE_HOURS` (§7.15) |
| GET | /invite?token= | — | **Server-rendered HTML** invite-acceptance page (opened from the email link). Shows device name + locked email, collects password + RODO consent |
| POST | /api/devices/accept_via_web | — | Redeems an `invite_token`: creates the account (if new) + `device_shares` row. Never resets an existing account's password |
| GET | /api/devices/shared_users | JWT | Owner-only: list co-admins on a device |
| POST | /api/devices/revoke_share | JWT | Owner-only: remove a co-admin (service shares included) |
| GET | /api/logs/search | JWT | Filtered/paginated log search — `mac`, `category`, `q`, `from`, `to`, `limit`, `offset` |
| POST | /api/user/rename / toggle_active / delete | JWT | Manage RFID cards (address by stable `id`). The change is written to the DB and **queued for the device by card UID** (`N`/`A`/`D`, §7.3) — responds `{queued:true}`; the app shows a warning until the device acks |

---

### 3.7 Package limits on existing credentials (downgrade / expiry)

Product decision of 2026-08-18, confirmed 2026-09-14 (`LICENSING.md` §3.4). When an account drops below its current usage (licence expired → `free`, or tier changed manually), the server does **not** grandfather the excess:

- `enforceLicenseLimits(accountId)` (`server.js`, search for the function) runs for every account at startup and every 6 h (`enforceLimitsForAllAccounts`).
- Cards above `max_cards` and PINs above `max_pins` are **deactivated** (kept for **90 days**, then deleted — decision 2026-09-14, implemented the same day in `runLicenseLifecycle()`: `licenseExpiryReminders()` e-mails + pushes the owner 7 days and 1 day before `license_valid_until` (stages tracked in `accounts.license_notice_stage`, reset when the term changes), `lockedCredentialLifecycle()` warns 10 days before deletion (`license_delete_notice_sent`) and deletes rows locked longer than `LOCKED_CREDENTIAL_DAYS` (default 90; cards also get a `D|uid` command so the device forgets them). Runs 90 s after start and every 24 h): `is_active=false, license_locked=true`; for cards the device gets `A|<uid8>|0` through the command queue (§7.3). Order of survival: credentials the owner marked with `keep_on_downgrade` (`POST /api/license/keep_selection`, app screen "Pakiet i licencja") → the owner card/PIN (`is_owner_card` / `is_owner_pin`, `POST /api/user/set_owner_card`) → oldest first. **The owner card/PIN is never locked.**
- Co-admin shares above `max_admins - 1` are **removed** (`device_shares` row deleted); service shares (§7.15) are exempt.
- On upgrade within those 90 days the locked credentials are restored automatically (`license_locked=false`, `A|uid|1`).
- Log retention falls to the new tier's `log_retention_days` (15 for free); older `system_events` are pruned by the retention sweep. Existing guest codes run to their expiry; new ones are refused (403).
- Firmware knows nothing about online licences; it only executes `A|uid|0/1`. The offline cap (`OFFLINE_FREE_CARDS`, §5.12) is enforced separately and only blocks *adding*.

Until 2026-09-14 `LICENSING.md` §3.4 described the earlier "grandfathering" model — that text was wrong since 2026-08-18.

## 4. Database (PostgreSQL)

```bash
psql_smartlock_db                          # alias, interactive session as admin
```

### 4.1 Key tables (as of this session)

```sql
-- Accounts. NOTE: there is NO `CREATE TABLE accounts` anywhere in this repo — the base
-- table was created out-of-band and is only ever referenced. Added columns therefore
-- ship as `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` inside runSchemaMigrations().
SELECT * FROM accounts;
-- id, email, password_hash, privacy_policy_accepted_at, reset_token, reset_token_expires,
-- push_token, push_entries, push_alarms,
-- licensing:    license_tier, max_cards, max_pins, max_admins, max_devices,
--               log_retention_days, guest_codes_enabled, pin_changes_per_month,
--               license_valid_until, p24_customer_ref
-- verification: email_verified (DEFAULT true → existing accounts are grandfathered;
--               registration sets it false explicitly), email_verify_code, email_verify_expires
-- sessions:     token_version (bumped on password change/reset → old JWTs die, §7.4)
-- licence codes and GDPR (Aug 18 / Sep 11 2026):
SELECT * FROM license_codes;      -- code (PK, 16 chars, prefix SLVR/GOLD/INDV), tier, days, used_by, used_at, created_at
SELECT * FROM pin_change_events;  -- id, account_id, mac_address, action, created_at — counts PIN additions per device per month (pin_changes_per_month limit)
SELECT * FROM erasure_requests;   -- id, email_hash (SHA-256, never the address), account_id, requested_at — tombstone re-applied after a backup restore

-- Devices (multi-device: one account can own many; device_shares grants co-admin access)
SELECT * FROM devices;
-- mac_address (PK, no 'id' column!), account_id, device_name, last_known_ip (NOT NULL! informational only,
-- private IPv4 — the server never connects to it), operational_mode, firmware_version,
-- last_heartbeat, auto_lock_delay_ms, device_key_hash (SHA-256 of the device key, §7.2)

-- Command queue for devices (card changes, WiFi) — delivered in the poll, §7.3
SELECT * FROM device_commands;  -- id, mac_address, cmd, created_at, delivered_at, acked_at

-- Multi-admin
SELECT * FROM device_shares;   -- id, mac_address, account_id, invited_by, created_at,
                               -- is_service (outside the admin limit), expires_at (NULL = permanent; service shares expire)
SELECT * FROM device_reports;  -- id, mac_address, kind (0 self-test / 1 diagnostics / 2 +relay), payload (JSON), created_at
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
-- expires_at, max_uses, use_count, is_guest_code,
-- is_owner_pin, license_locked, keep_on_downgrade   (limit enforcement, §3.7)

-- RFID cards (server-side record — see §5.7/5.8 for sync caveats with the ESP32's own card store)
SELECT * FROM card_credentials;
-- id, mac_address, holder_name, card_uid, is_active, hardware_slot_idx,
-- schedule_enabled, schedule_days, schedule_start_minutes, schedule_end_minutes,
-- is_owner_card, license_locked, keep_on_downgrade   (limit enforcement, §3.7)

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
| BUTTON_PIN | 33 | INPUT_PULLUP. Tap = open, hold 3 s = learning mode. **No longer does factory reset** — that moved to its own button |
| RESET_BTN_PIN | 39 (VN) | **Dedicated FACTORY RESET button.** Input-only pin with **no internal pull-up → external 10 kΩ to 3.3 V is mandatory**, button to GND. Hold **3 s during normal operation** (OLED counts down, release = cancel) or **2 s while powering on** → wipes EEPROM + LittleFS and auto-restarts into `CTRLABLE_SETUP`. Note VN/VP are *not* power pins despite the names |
| LED_GREEN | 25 | |
| LED_RED | 26 | Now also flashes 2× on RFID card denial (unknown or blocked card) |
| BUZZER_PIN | 27 | |
| RST_PIN (RFID) | 4 | |
| SS_PIN (RFID) | 5 | |
| TAMPER_PIN | 32 | INPUT_PULLUP, `TAMPER_INSTALLED = true` (NC switch to GND; older notes about IO36 are obsolete) |
| KP_ROW1–4 | 14, 15, 34, 35 | INPUT_PULLUP; 34/35 lack true internal pull-up (input-only pins) |
| KP_COL1–3 | 16, 17, 12 | OUTPUT. Custom PCB rev 0.2: COL3 = **2** (`BOARD_PCB_REV02`, §5.1b) |
| I2C SDA/SCL (OLED) | 21, 22 | `Wire.begin()` default |
| RFID SPI (SCK/MOSI/MISO) | 18, 23, 19 | Default VSPI |

### 5.1b Custom PCB rev 0.2 (`../CTRLABLE-Node-PCB`) and the `BOARD_PCB_REV02` build flag

The production board (KiCad 9 project one folder above the repo, ordered from JLCPCB on 2026-09-14) replaces the 30-pin dev kit with a bare **ESP32-WROOM-32E-N4** module, a 12 V → 3.3 V buck, the relay, USB-C + CH340C auto-reset and screw terminals for everything external. **All pins are identical to the table above except one:** `KP_COL3` moves from **IO12 to IO2** (IO12 is the MTDI strapping pin — a keypad key held at power-up would stop the module from booting; on the custom board IO12 only drives the exit-button LED through an NPN and IO2 has no on-board LED). The firmware selects this with a compile-time flag:

```cpp
#ifndef BOARD_PCB_REV02
#define BOARD_PCB_REV02 0     // 0 = dev kit (KP_COL3 = IO12), 1 = custom PCB rev 0.2 (KP_COL3 = IO2)
#endif
```

CI (`compile-ESP32.yml`) builds the dev-kit variant until the fleet moves to the PCB; build the PCB variant locally with `--build-property "build.extra_flags=-DBOARD_PCB_REV02=1"` (arduino-cli) or by flipping the default. Everything else on the PCB works with the unchanged firmware: exit button on J8 pin 1 (NO → R18 pull-up → IO33, COM = GND), relay via Q1 on IO13 (HIGH = energised), buzzer via Q2 on IO27, tamper on IO32, factory reset SW3 on IO39. Reserved for later firmware work: `BTN_NC` (IO36, NC contact of the exit button, R31 pull-up) and `BTN_LED` (IO12, open-collector LED drive). Board-level details, BOM and JLCPCB ordering pitfalls: `../CTRLABLE-Node-PCB/README.md`.

### 5.2 Server connection — architecture note (important)
```cpp
#define PROXMOX_SERVER "node.ctrlable.pl"
#define PROXMOX_PORT   443   // TLS via NPM (was 3000 plain HTTP)
```
**Must stay as the domain name, not a local IP.** Devices will eventually be field-deployed at customer sites, not on this LAN — a hardcoded local IP would only work here and break everywhere else.

**TLS migration — DONE and verified in the field (Aug 2026).** All outbound cloud calls use `WiFiClientSecure` on port **443** through NPM (same path as the app), replacing plain-HTTP `WiFiClient` on 3000. Server identity is validated against a **pinned root CA** — `ROOT_CA_LE` holds the Let's Encrypt **ISRG Root X1** PEM (embedded) via `setCACert` — MITM-resistant; the LE leaf renews every ~90 days but the root is stable for years. Local AP/provisioning `server.accept()` clients are unchanged. Poll, keypad PIN, app unlock and OTA are all confirmed working over TLS; port 3000 is closed at the router.

**Every request to the server carries `X-Device-Key`** (the device's random 32-byte key, §7.2) — poll, scan, register, keypad, tamper, logs, firmware download. The poll also sends `ack=<last executed command id>` and receives the next command batch in `cmds` (§7.3).

Poll cadence is **1 s**, backing off to **8 s** after 3 consecutive failures. An earlier note here described 2.5 s with "widened read deadlines" — that approach is obsolete and was actively harmful; see §5.2b for why the read must end on a complete JSON body rather than on socket close.

### 5.2b Dual-core split — **NEVER call TLS from `loop()`** (read before touching networking)

A `WiFiClientSecure` handshake to the LE-signed host costs **1.5–4 s on ESP32**. Anything doing that inside `loop()` freezes core 1: LED stops blinking, OLED freezes, buzzer stutters, confirmations lag.

**This was the root cause of the long-running "card reading takes 3–4 s" saga.** The RFID read itself was always instant — what lagged was `transmitCardPayloadToCloud()` running inline in `loop()` after every scan (`/api/hardware/scan` on each tap, `/api/hardware/register` while learning). The physical button had the same bug (the cloud log ran *before* `openDoor()`).

Layout now:
- **Core 1 (`loop`)** — RFID, relay, OLED, buzzer, keypad, button. Never blocks on the network.
- **Core 0 (`networkTask`, 12 KB stack)** — every TLS call: poll, card-scan upload, button log, FS report.
- Hand-off is one-way via `volatile` flags + plain globals: `req_unlock`, `req_ota`, `req_deregister`, `req_usernameUpdated`/`req_username`, `req_cardUpload` (+ `up_uid`/`up_name`/`up_slot`/`up_register`), `req_buttonLog`, `forceSyncNow`. Hardware actions are executed **only** by `loop()`.

**Order inside `networkTask` matters:** poll **first** (it carries the `opened` lock state), then card upload, then button log. Each is a separate handshake, so putting uploads first delayed the open-state report by ~4 s — past the 3 s auto-lock window, so the app showed "Otwarto" only after the lock had already closed.

**Poll timeouts must stay generous** — connect 4000 ms, handshake 6 s, I/O 6000 ms. They were once cut to 500 ms / 2 s / 250 ms (from the era when the poll blocked `loop()`); every poll then failed with `[NET] Serwer nie odpowiada`, and since **device registration happens only via the poll**, the device could never attach to an account.

**Read the response until the JSON is complete, not until the socket closes.** With TLS, `connected()` stays true well after the body arrives, so a "wait for close" loop burns the whole deadline. A 6 s read window made each poll take ~6 s → remote unlock timed out, the device flapped offline for 15–20 s. The loop now counts braces and exits on the closing `}`; the deadline is only a backstop.

### 5.3 OTA update workflow
**Only signed images are installed (§7.5).** `compile-ESP32.yml` signs every build with the `FIRMWARE_SIGNING_KEY` secret and attaches `lock_<version>.bin.sig` (e.g. `lock_v3.1.0.bin.sig`); the server refuses to arm OTA for a release without it, and the firmware rejects an image whose signature doesn't match the public key compiled into it. A manual Arduino-IDE build must be signed the same way (`openssl dgst -sha256 -sign <key> -out lock_x.bin.sig lock_x.bin`) before it is attached to a release.

**The workflow runs only when `access_control.ino` (or the workflow file itself) changes** (since Sep 16 2026 — before that every push, e.g. of `server.js`, produced a `<version>-build.<n>` release that the server then pushed as a "newer" firmware). **Version = `app_version` in `access_control.ino` (e.g. `v3.1.0`) — the only place to bump it.** `compile-ESP32.yml` reads it and names the release from it: tag `v3.1.0`, title *Firmware v3.1.0 (build N)*, assets `lock_v3.1.0.bin` + `.sig`. A further push to `main` without bumping the version gets the tag `v3.1.0-build.<N>` so OTA (which compares `release.id`) still sees a newer release; the clean tag stays with the first build of that version. Bump `app_version` for anything you want customers to see as a new version. (Releases before 2026-09-11 were tagged `build-<version>`.)

1. Bump `app_version` if this is a new version; build `.bin` (Arduino IDE or GitHub Actions auto-build on push)
2. **Don't edit an existing release's assets** — delete the release (keep the tag), draft a new one on the same tag, attach the new `.bin`. Keeps version string stable while giving OTA logic a fresh `release.id`.
3. `rm /opt/smartlock-server/updates/lock_*.bin` to clear cache
4. Trigger from app: Firmware screen → Check for updates → Update
5. **Client-facing OTA messages are now simplified** (server-side filtering in `/api/hardware/log`) — users see only 3 states: "Próba nawiązania połączenia...", "Aktualizacja w toku...", "Aktualizacja zakończona pomyślnie ✅". Raw technical detail (byte counts, headers) stays in the file log only.

**⚠️ Factory-reset trap — "app says you're on the newest firmware" when you are not.**
`installedReleaseId` lives at EEPROM offset 480. `factoryResetSettings()` writes `0xFF` over all 512 bytes, so it reads back as **4294967295** — larger than any real GitHub release id. The comparison `latest > installed` is then always false, so OTA is never offered and the app reports "Jesteś na najnowszej wersji". It is self-locking: the firmware fix can only arrive by OTA, which is exactly what's blocked.
**Fixed server-side (the durable fix):** any reported `release_id > 4_000_000_000` is treated as `0`, in **both** places — the `otaUpdateTrigger` comparison *and* where `actualLockStates[mac].deviceReleaseId` is stored (that is what `/api/data` feeds to the app's update screen; patching only the first is not enough), plus the stored fallback so a bogus value can't survive later polls.
Firmware additionally writes `0` to offset 480 on factory reset and zeroes implausible ids at boot. After a USB flash the id is `0`, so one redundant OTA may be offered — acceptable.

**The server only refreshes the GitHub "latest release" at startup, or when the app calls `/api/firmware/version`** (the "🔍 Sprawdź dostępność aktualizacji" button). It never polls GitHub in the background, so a fresh CI build stays invisible until one of those happens.

### 5.4 On-device storage — LittleFS (cards) + EEPROM (config)

**Cards no longer live in EEPROM.** They are stored in **LittleFS `/cards.db`** as fixed-length `FsCard` records (~40 B), capacity `HW_MAX_CARDS = 200`, loaded into `users[]`/`isCardActive[]` at boot. `/pins.db` (`FsPin`, ~73 B) is reserved for stage 2 (local PIN verification) and not used yet.

**EEPROM (512 B) still holds the configuration** — and, in a degraded mode, cards:

| Address | Data | Still current? |
|---|---|---|
| 250 | `0x55` magic — "device is configured" | ✅ |
| 260 | ssid | ✅ |
| 292 | pass | ✅ |
| 324 | owner_email | ✅ |
| 400 | local admin password (16 chars, offline mode only) — random per offline setup, wiped by factory reset | ✅ since 2026-09-11 (§7.1) |
| 480 | installedReleaseId | ✅ — **factory-reset trap, see §5.3** |
| 0 / 10+ / 220+ | totalCards / `User` structs / isCardActive flags | ⚠️ **fallback only** — used when LittleFS fails to mount, capped at 10 cards |

**Degradation is deliberate:** if `LittleFS.begin()` fails, `fsMounted = false` and the firmware falls back to the old EEPROM path (10-card cap) instead of losing cards entirely — a lock must never lose its credentials. `persistCards()` dispatches to whichever store is active; on first boot with an existing EEPROM card set it migrates them into `/cards.db` (`[FS] Migracja kart EEPROM->LittleFS`).

**NVS (Preferences, namespace `ctrlsec`)** holds the device secrets that deliberately **survive a factory reset**: `dkey` (device key, §7.2) and `appw` (WPA2 password of `CTRLABLE_SETUP`, §7.1). Keeping the key means a factory-reset device re-attaches to its existing server record instead of being rejected; an ownership change goes through deregistration anyway.

`factoryResetSettings()` clears **both**: `0xFF` across all 512 EEPROM bytes (plus `totalCards = 0`, and `0` written back to offset 480) **and** removal of `/cards.db` + `/pins.db`.

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
**RFID card matching and the unlock decision happen LOCALLY on the ESP32, from its own card store** (`memcmp` against the `users[]` array, loaded at boot from LittleFS `/cards.db` — see §5.4) — **not** server-verified like keypad PINs. `transmitCardPayloadToCloud()` / `/api/hardware/scan` is a fire-and-forget report to the server for logging/push-notification purposes only; it does not gate the physical unlock.

**RFID schedules are now enforced locally (Aug 18 2026) — this used to be a real gap.** Previously `/api/user/update_schedule` wrote the schedule to the database and the app displayed it, but the ESP32 decided on UID alone, so a card restricted to "Mon–Fri 8–16" opened the door at any hour. The UI promised access control the product did not deliver.

How it works now:
- Schedules live on the device in `FsCard` (LittleFS) — the fields already existed and were written as zeros. In RAM they are kept in **parallel arrays** (`cardSchEnabled/Days/Start/End`), deliberately *not* inside `struct User`: `User` is what the EEPROM fallback writes at offset 10 (10 × 20 B), so widening it would overrun the `isCardActive` flags at offset 220.
- The server **queues** every schedule change for the device as an `S|<uid8>|<en>|<days>|<start>|<end>` command (`queueCardCommand`, delivered in the next poll and acked, §7.3) — addressed by card UID, not by hardware slot. (`/api/set_schedule?idx=` survives only in the offline local API of the firmware.)
- `cardAllowedNow(idx)` is checked before `openDoor()`. Denial logs `Odmowa: Poza harmonogramem` and shows `POZA HARMONOGRAMEM` on the OLED.
- **Unknown clock = deny, for scheduled cards only.** If NTP hasn't set the time (`now < 100000000`), a card with a schedule is refused (`Odmowa: brak czasu`). Fail-closed is safe here precisely because it touches *only* time-restricted cards — an owner card without a schedule always works, so nobody gets locked out by a failed NTP sync.
- `deleteUser()` shifts the schedule arrays along with the cards; without that, deleting one card would hand its neighbours the wrong time windows.
- **EEPROM fallback mode carries no schedules** (no room) — cards there behave as unrestricted, and the arrays are explicitly reset on load so stale RAM can't refuse a card.

**Known limitation:** schedules reach the device only when they are *changed* in the app. Cards whose schedule was set before this feature existed — or a device that has been factory-reset — need the schedule re-saved once to push it down. There is no full reconciliation pass yet (same class of drift as §5.8).

### 5.8 Device ↔ database sync — known fragility
Because RFID matching is local (§5.7), the ESP32's own card store (LittleFS `/cards.db`, §5.4) and the server's `card_credentials` table are **two independent copies** that can drift out of sync — confirmed to happen in practice (a card named "Tomasz 2" existed on the device, fully functional for physical unlock, while completely absent from the server database and invisible in the app).

Causes: learning a card while the server connection is down (the local write succeeds, cloud registration silently fails); deleting/renaming via the app updates the database and **queues** the change for the device (`N`/`A`/`D` by UID, §7.3); until the device polls and acks, the app shows the pending-commands banner and the two stores differ. (Historical: before Sep 2026 the server tried to reach the ESP32's local HTTP endpoints, which only worked on the server's own LAN.)

**The `idx` ambiguity is fixed (Aug 17 2026) — it used to corrupt data, not just drift.** `/api/data` returned `idx = hardware_slot_idx` (the EEPROM/LittleFS slot), while every mutation endpoint did `cards.rows[idx]`, treating it as an **array position** in an `ORDER BY id ASC` list. Those agree only by coincidence: after resets or re-enrollment several cards shared the same (or NULL) slot, so **rename / toggle-active / delete could hit the wrong card**, and the app rendered duplicate React keys (two inline editors opening at once).
Now `card_credentials.id` is the single identity: `/api/data` returns both `id` (stable, used for keys and mutations) and `idx` (hardware slot, used **only** when relaying to the device). Server-side `resolveCardRow(mac, body)` prefers `body.id` and falls back to `body.idx` for older app builds; `cardHwSlot()` picks the slot to send to the firmware (computed *before* the row is deleted). Applied to rename, update_schedule, toggle_active and delete.

**Duplicate enrollment is fixed too:** `saveNewCard()` had no UID check, so re-presenting the same fob in learning mode appended another slot (2 fobs produced 7 entries). It now matches by UID and updates the existing record.

**Card names are capped at ~15 bytes** — the RAM/EEPROM `User` struct is `char name[16]` and Polish UTF-8 characters take 2 bytes ("Nowy Użytkownik" → "Nowy Użytkowni"). It cannot simply be widened: 10 EEPROM records with a longer name would overrun the `isCardActive` flags at offset 220 within the 512-byte EEPROM. `FsCard` (LittleFS) already reserves `name[24]`, but the in-RAM struct still caps it.

**Card naming only started working on Aug 17 2026.** The "new profile name" field wrote to `newName`, but `handleToggleLearn()` called `executeCommand('/api/toggle_learn')` with no parameters, so the name was silently dropped and every card became "Nowy Użytkownik". `/api/toggle_learn` is a **GET** (the helper only POSTs when handed a payload), so the name has to ride in the URL: `?username=...` → `learningQueues[mac]` → poll response `username` → firmware `req_username` → `pendingUsername`.

**Direct local inspection is gone (2026-09-11).** In online mode the ESP32 no longer listens on the home network at all, and the MAC-derived "factory password" that these commands used no longer exists (§7.1). Card changes reach the device by UID through the command queue (§7.3), which also removes the slot-index ambiguity described above for everything the app does. To see what the device holds, use the app, the server logs (`Hardware Remote Log` / `User Mutation`) and `device_commands` (acked or still pending).

For a genuinely clean slate, the physical factory reset (§5.1) plus deleting that MAC's rows server-side is more reliable than reconciling by hand:
```sql
DELETE FROM card_credentials WHERE mac_address='<MAC>';
DELETE FROM keypad_pins      WHERE mac_address='<MAC>';
```

### 5.9 RFID antenna gain
```cpp
rfid.PCD_SetAntennaGain(rfid.RxGain_max);  // in forceHardwareRFIDReset(), after PCD_Init()
```
Set to maximum (48dB) to help with weaker tags (keyfobs vs. cards). **Tested and did not resolve** a specific case of a keyfob failing to read behind a keyboard enclosure — that turned out to be a pure physical range limitation (small keyfob antenna + added plastic distance), not a gain/software issue. RC522's antenna is etched directly on the PCB (not a swappable/extendable coil), so options there are limited to: physically reducing the distance (machining a recess in the enclosure), or accepting cards-only in that specific mounting location.

### 5.10 Provisioning page security
See **§7.1** for the full model. In short: the setup page (`http://192.168.4.1`) exists **only** on the `CTRLABLE_SETUP` access point, which is WPA2-protected with a random per-device password shown on the OLED **only in first-setup mode**; in online mode nothing listens on the home network. The page never pre-fills the saved WiFi password, escapes the SSID/email it echoes, and the full request line (which contains the WiFi password) is no longer written to the log.

### 5.11 Deregistration command (owner-triggered device wipe)
Every poll response is parsed for `"deregister":true` (alongside `unlock`/`ota`/`learn`). When set, the firmware runs `factoryResetSettings()` then `ESP.restart()`. On reboot `loadConfiguration()` finds no `0x55` magic at addr 250 → `provisioningMode = true` → `CTRLABLE_SETUP`. This wipes **stored data only** — 0xFF across the 512-byte EEPROM (WiFi, owner_email, release id, legacy card fallback) **plus** LittleFS `/cards.db` and `/pins.db`; the program flash is separate and untouched.

**A deregister only reaches a device that is online and polling.** A device sitting in `CTRLABLE_SETUP`, or one that can't reach the server, never receives the flag — use the physical reset button (§5.1) instead. Likewise a factory-reset, unprovisioned device blocks in the provisioning `while(true)` loop and never starts `networkTask`, so it sends **no poll and no remote log at all**: total silence server-side is expected until it is provisioned, not a fault. The server sends `deregister:true` only during the 120 s window after an owner confirms deregistration (§3.6, §6.11), and blocks auto-re-registration during that window so the wiped device can't immediately re-add itself. **The wipe command is only handed to the real device:** the hash of its key is captured before the DB row is deleted, and polls in the window without that key get 401 (§7.2). **This command handling must be present in the deployed firmware** — build + OTA after changing it.

### 5.12 Offline licence — signed token bound to the device (DORMANT — not sold since 2026-09-14)

> **Product decision 2026-09-14:** offline mode is **free-tier only** (2 cards, no PINs). The offline licence token is **not sold**; the mechanism below stays in the firmware, `tools/licensekey.js` and the app in a dormant state (do not remove, do not advertise). `LICENSING.md` §3.5.

Offline-standalone devices are capped at **`OFFLINE_FREE_CARDS = 2`** cards without a licence (this cap did not exist in firmware before 2026-09-11 — it was documentation only). More cards need an **offline licence token**: `OFL1.` + base64url(`payload[12]` + ECDSA-P256 signature, DER). Payload: `[0]=1` version, `[1..6]` MAC, `[7]` max cards, `[8]` max PINs, `[9]` tier (1 silver / 2 gold / 3 individual), `[10..11]` issue day. Tiers mirror the online ones (`LICENSING.md` §3.5).

- **Signed by the producer's licence key** (`license_signing_private.pem` kept off-server; `tools/licensekey.js` defaults to `/opt/smartlock-server/license_private.pem` unless `LICENSE_SIGNING_KEY_FILE` points elsewhere — separate from the firmware signing key). The firmware embeds only the public key (`LICENSE_PUBKEY_PEM`), verifies the signature and that the MAC is its own — no secret in the device, a copied token is useless on another unit.
- **Stored in NVS `ctrlsec/oflic` and kept across factory reset** (the licence belongs to the hardware). Perpetual: an offline device has no trusted clock.
- **Enforced in `saveNewCard()`** only in offline-standalone mode (`ssid == "OFFLINE_MODE"`): cap = licence cards, else 2. Existing cards above the cap keep working (only adding is blocked); the learning flow now handles the refusal ("LIMIT KART: N" on the OLED, denied sound, no cloud upload) — previously a failed save was still reported as "DODANO KARTE".
- **Installing:** at the factory, in first-setup mode on the AP: `GET http://192.168.4.1/set_license?token=...` (no local password exists yet; the AP is WPA2-gated). Later, in offline mode: `GET /api/set_license?token=...&pass=<local password>` — the app does this from *Ustawienia → Licencja offline*. The local `/api/data` reports `license {tier, cards, pins, active}`, `free_cards` and an `entitlements` object shaped like the server's, so the app's limit UI works unchanged.
- **Generating:** `LICENSE_SIGNING_KEY_FILE=... node tools/licensekey.js offline D4:E9:F4:78:08:60 gold` (or `individual:120,120`); check without a device: `node tools/licensekey.js offline-verify <token> license_signing_public.pem`.
- PINs: the token carries `max PINs`, but offline PIN verification is still open (§9) — an offline licence is cards-only until then.

### 5.13 Crash diagnostics — reset reason and core dump in the boot log (v3.2.1)

Every boot sends the `[FS] LittleFS …` line; since v3.2.1 it ends with ` reset=<code>/<name> heap_min=<bytes>` and, when the previous run died in a panic or watchdog, ` CRASH task=<name> pc=0x… cause=<n> bt=0x…,0x…`. The ESP32 core writes an ELF core dump to the `coredump` partition (default 4 MB partition table; `CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH=y` in the Arduino core) — the firmware reads `esp_core_dump_get_summary()`, sends it once and erases the dump. Reset codes: 1 POWERON, 3 SW (OTA/ESP.restart), 4 PANIC, 5 INT_WDT (interrupts blocked > 300 ms), 6 TASK_WDT, 9 BROWNOUT.

**Breadcrumbs (v3.2.3):** because a crash that hits during a flash operation leaves no core dump (the panic handler cannot write flash then), both cores continuously stamp their current phase into RTC memory (`RTC_NOINIT_ATTR`, survives every reset except power-on) and every flash write sets a marker. After an unexpected reset the boot line also carries ` crumbs c0=<phase>@<ms before death> c1=<phase>@<ms> flash=<op> up=<s>`. Core 0 (netTask) phases: 1 loop, 2 poll connect, 3 poll send, 4 poll read, 5 poll parse, 6 card upload, 7 diagnostic report, 8 button log, 9 sendRemoteLog. Core 1 (loop) phases: 20 loop start, 21 pending commands, 22 tamper, 23 keypad, 24 OLED render, 25 RFID reset, 26 Wi-Fi rescue, 27 RFID scan, 28 button, 29 openDoor, 30 OTA. Flash ops: 1 EEPROM.commit, 2 /cards.db write, 3 NVS, 4 OTA write, 5 self-test, 6 coredump erase (`flash=0` = no flash op in progress). A phase with a large `@ms` age means that core had been stuck there. Since v3.2.6 the report is kept in RTC memory until the boot line has actually been sent: a boot that itself dies before writing any marker (first ~1.5 s: driver init, radio power-up) no longer wipes it but increments ` early_crashes=<n>`, and ` crash_reset=<code>/<name>` names the reset that ended the reported run (Sep 16 2026: every reset produced two boots and the second one reported all zeros). Since v3.2.4 the boot line also carries ` sw=NET_STALL(n)` when the **server-contact watchdog** fired: with Wi-Fi associated but no successful poll for 10 min (60 min once three such restarts happened in a row without a single successful poll) `loop()` — core 1, so it works even with the network task hung — restarts the device (not in AP/provisioning, learning mode, with the door open or during OTA). Sep 15 2026: a v3.2.2 unit sat 17 h "online" on the OLED without a single poll — and woke up with an INT_WDT the moment its cables were moved, i.e. a loose contact. v3.2.5 adds a **task watchdog on `loop()`** (60 s, `esp_task_wdt`): a hung main loop (I2C/SPI bus stuck) now ends in a `6/TASK_WDT` reset with breadcrumbs instead of hanging forever; the OTA receive loop and a held exit button feed it explicitly.

Decoding: the release now also carries `lock_<version>.elf`. Run `bash tools/decode_backtrace.sh lock_v3.2.1.elf 0x400d1234,0x400d5678` (uses `xtensa-esp32-elf-addr2line` from the installed Arduino ESP32 toolchain) to get file:line for every frame. The `.elf` matches only the exact build — decode a v3.2.1 trace with the v3.2.1 `.elf`.

Server side (Sep 15 2026): every boot line is inspected per device — an unexpected reason (PANIC / watchdog / BROWNOUT) becomes a `security` event in the app's log, and 3 or more *unexpected* boots within an hour (SW/POWERON resets from OTA, the app or a power cycle do not count) push "Centralka restartuje się" to the owner (`recordDeviceBoot`, at most one alert per hour, RAM-only counter).

Also since v3.2.1: `WiFi.setSleep(false)` (modem-sleep off — a frequent cause of dropped associations with some routers; irrelevant on mains power).

---

## 6. Mobile App (React Native / Expo)

### 6.1 Key configuration
| Setting | Value |
|---|---|
| backendUrl | `https://node.ctrlable.pl` (always — verify after every regeneration) |
| SDK | Expo SDK 57 (`expo ^57`, React Native 0.86) |
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

### 6.2b Onboarding flow — account first, device second (redesigned Aug 17 2026)

Order is dictated by networking: account steps need the internet, while configuring the device needs the phone joined to `CTRLABLE_SETUP` (which has none). So the account must exist **before** you connect to the AP.

```
Start → "Jak uruchomić centralkę?"
  ├─ 🔌 Offline (local) ──────────────────────────────► Device init (CTRLABLE_SETUP → local mode, no account)
  └─ ☁️ Online → "Masz konto?"
        ├─ Mam konto → Login ─────────────┐
        └─ Nowe konto → Register (RODO checkboxes) → 6-digit code screen → activated ┤
                                                                                     ▼
                                    Device init (CTRLABLE_SETUP → home WiFi + account email)
```

- **The firmware no longer creates accounts.** The app sends an **empty `reg_pass`**, so the firmware's `if (decodedRegPass.length() > 0)` block (which used to POST `/api/auth/register` itself) is skipped. It still stores `owner_email` and sends it in every poll — that is what attaches the device to the account.
- **No fake auto-WiFi.** Expo Go cannot switch networks, so the "connect" step shows step-by-step instructions plus an "Otwórz ustawienia Wi-Fi" shortcut, and only then validates with a real `fetch('http://192.168.4.1/')`. The earlier simulated `NEHotspotConfiguration` dialog just failed silently.
- **Config send is probed first.** The app pings `192.168.4.1` before submitting; without it the request went nowhere while the UI still claimed success (see below).
- **"Konfiguracja wysłana ✓" is reported for both success and failure — on purpose.** `WiFi.begin()` moves the SoftAP to the home network's channel, so the phone drops off `CTRLABLE_SETUP` and the HTTP reply almost never arrives even though the GET landed and settings were saved. Real confirmation is the device appearing in the list.
- **The account email must be persisted.** Switching the phone to `CTRLABLE_SETUP` breaks the Metro connection, so Expo Go reloads the bundle: the JWT survived (AsyncStorage) but the in-memory `email` state did not, and the device was provisioned with an **empty owner email** → it polled forever with `email=''` and never registered. It is now stored under `@lock_account_email` at login/verification, restored on boot, cleared on logout, and the send is hard-blocked when missing.

### 6.3 Multi-device support — the "🏠 Centralki" module (restructured Aug 17 2026)

**All device management lives in one screen** (`currentScreen === 'devices'`), reached from the drawer. It replaced the old "➕ Dodaj centralkę" menu entry, and absorbed the management controls that used to be scattered across the dashboard switcher and Settings. Per device it offers: name, online status, mode, MAC + firmware version, active/select marker, and — for owners — **auto-lock presets (§6.7)**, **rename**, and a jump to **Administratorzy**. At the top: "➕ Dodaj nową centralkę" (re-enters the provisioning flow with the session kept) and "🔑 Mam kod zaproszenia". Shared (non-owned) devices are listed without owner controls.

**The dashboard is deliberately minimal:** the switcher now appears only with **>1** device (nothing to switch with one) and does exactly one thing — pick which centralka the remote-unlock button targets. Its modal no longer carries rename/admin buttons; it links to the Centralki module instead.

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
- **Card scheduling is enforced locally by the ESP32** (`cardAllowedNow()`, "Poza harmonogramem" denial) since Aug 18 2026 — see §5.7. Limitation: the schedule reaches the device only when it is changed (queued `S` command), so a device that was offline during the change applies it after its next poll.

### 6.6 Log filtering/search
- Dashboard log screen has a **⏱ Na żywo / 🔍 Szukaj** toggle.
- Search mode: free-text search, category chips (🚪 Wejścia, ⚠️ Bezpieczeństwo, ⚙️ Konfiguracja, 🔄 Aktualizacje), date range, pagination ("Załaduj więcej").
- Old log entries predating the categorization migration show as uncategorized (grey dot) — expected, not a bug.

### 6.7 Configurable auto-lock delay — **per device** (implemented for real Aug 17 2026)

> **This section previously described a feature that never worked.** It documented a numeric input in Settings and an endpoint `/api/settings/auto_lock` — neither existed. Only the firmware half was present, and even that was broken (see the off-by-one below). Treat the old text as a warning about documenting intent as if it were shipped.

- **Where:** 🏠 **Centralki** module → each owned device has its own preset row **3s / 5s / 10s / 15s / 30s**. Not in Settings, and not account-wide: a gate needs longer than a front door.
- **Owner-only** (like rename / WiFi). Co-admins can unlock and manage cards/PINs but not change lock parameters, so the control isn't rendered for them.
- **Storage:** `devices.auto_lock_delay_ms` (default 3000). `/api/data` exposes it as `autoLockSeconds` both for the active device and per entry in the `devices` list.
- **Delivery:** the poll response carries `auto_lock_delay` (ms); the ESP32 applies it on the next cycle, no restart. Firmware clamps to 1000–60000 ms and keeps 3000 ms if absent/invalid.
- **Presets instead of a free numeric field** — makes out-of-range values unrepresentable rather than silently rejected by the firmware.
- **Firmware off-by-one (fixed):** the parser advanced by **19** characters past `"auto_lock_delay":`, but that key is **18** long — so it dropped the value's first digit (`10000` → `"0000"` → `0`), failed the `>= 1000` check, and silently kept 3 s. The bug sat dormant for as long as the server never sent the field. The length is now derived from the key, not hardcoded.
- Practical side effect: a longer window (5–10 s) also makes the app's "Otwarto" state comfortably visible, since the event no longer lasts less than the network round-trip.

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
Owner-only, per selected device, two-step with an emailed 6-digit code (the section only renders when the active device's `isOwner` is true). Flow: "🔌 Odłącz i zresetuj centralkę" → `deregister_request` emails a code → enter code → `deregister_confirm`. On confirm the server deletes the device and **all its data** (keypad PINs, cards, logs, co-admin shares) and commands the ESP32 (via poll `deregister:true`) to run `factoryResetSettings()` — wiping **stored data only** (EEPROM: WiFi + owner_email + release id; LittleFS: `/cards.db`, `/pins.db`); the **firmware/program flash is untouched**. The device reboots into `CTRLABLE_SETUP`; reconnecting means re-provisioning it as new. See §3.6 for the endpoints and §5.11 for the firmware side. **Requires the updated firmware (OTA) to work** — old firmware ignores `deregister` and simply re-registers after the 120 s block.

### 6.12 Security-relevant app behaviour (2026-09-11)
- **Session token and the offline local password live in `expo-secure-store`** (iOS Keychain / Android Keystore), not AsyncStorage. A small wrapper redirects just those two keys, so the rest of the code still calls `AsyncStorage`; values stored by older builds migrate on first read. On web it falls back to plain storage.
- **The hidden installer menu (5 taps on the logo) exists only in `__DEV__` builds** and forces `https://` — it used to remap the backend to plain `http://`, sending the password and token in clear text.
- **Password change** (Settings) asks for the current password and stores the fresh token the server returns; other phones are logged out.
- **"⏳ Zmiany czekają na centralkę (N)"** banner on Dashboard and the user list while `pendingCommands > 0` — until the device acks, a blocked card still opens the door.
- **Setup instructions mention the `CTRLABLE_SETUP` password** shown on the centralka's display.
- WiFi change and OTA now send the selected device's `mac`; minimum password length is 8 everywhere.
- **Self-test** button on every device card (*Centralki*) with a plain-language report; **"🛠️ Zaproś serwis (poza limitem)"** in *Zespół* (shown even when the admin limit is full); service shares are labelled with their expiry; a co-admin can leave a device ("Odłącz się"). The **Serwis** screen (session start → code from the OLED → diagnostics / relay test / restart / key reset / leave) renders only for `account.isServiceAccount` (§7.15).

---

## 7. Security

**Security audit 2026-09-11 → fixes in this revision.** The audit found that the door could be opened without any permission: from the customer's WiFi (unauthenticated `/save_setup` handing out the admin password, a local unlock guarded by a password derived from the MAC with a public algorithm), from anywhere in radio range in offline mode (open `CTRLABLE_SETUP`), and even at other customers' sites (wildcard remote-unlock queue). It also found that blocking a card in the app never reached devices outside the server's LAN, that devices were not authenticated at all (MAC = identity), that password-reset codes could be brute-forced (and the rate limiter never counted), and that anyone could trigger OTA on every device. The sections below describe the model that replaced it. The full audit report with exploit details is kept **outside this public repository**.

**Principles:** the server trusts a device only by its key, never by MAC or IP; the server never connects *to* a device — the device pulls everything over TLS; a centralka in online mode exposes no port on the home network; firmware runs only if signed by a key that is not on the server.

### 7.1 Device network exposure
- **Online mode: no listening socket on the home network.** `server.begin()` is never called when connected to WiFi, and `server.end()` runs when the device returns online from the fallback AP. All management goes through the server.
- **`CTRLABLE_SETUP` is WPA2-protected.** Password: 12 random characters (`apPassword`, NVS key `appw`), generated at first boot, kept across factory resets (like a sticker). **The OLED shows it only in first-setup mode** (new device or factory reset with the button inside the enclosure); the offline-mode screen and the fallback AP never display it. It is also printed on the serial port at boot (physical access).
- **Where the AP runs:** first setup, offline-standalone mode, and as a fallback when WiFi fails at boot (so a changed router can be fixed on site — still behind WPA2).
- **One local HTTP dispatcher (`handleLocalHttp`) serves the AP only:** the setup page / `/save_setup`, and the offline-mode local API. The old `handleProvisioningServer()` ran in every `loop()` iteration "also when online" with no authentication; it and `handleOnlineInstallerServer()` (which displayed the WiFi password) are gone.
- **Offline local API** is authorised by `localAdminPass`: 16 random characters generated **at every offline setup** (EEPROM @400), returned once in the `/save_setup?offline=1` JSON as `admin_pass` (field name kept for app compatibility), compared in constant time, 5 failures → 5 min lockout. Online setups clear it, so an online device has no usable local API even in fallback mode. **Removed from the local API:** `/api/update` (unsigned firmware over LAN), `/api/save_settings`, card UIDs and the admin password in `/api/data`.
- The old MAC-derived "factory password" (`getFactoryAdminPassword()`, a few thousand possible values computable from a MAC visible over the air) is deleted from firmware and server. Devices still running old firmware remain exposed until they take the OTA (§7.8).

### 7.2 Device key — how the server authenticates a centralka
- At first boot the firmware draws **32 random bytes** from the hardware RNG (radio enabled first, so `esp_random()` is truly random) and stores them in NVS (`dkey`). Every request carries it as `X-Device-Key: <64 hex>` over TLS.
- The server stores only `SHA-256(key)` in `devices.device_key_hash` and compares in constant time (`authenticateDevice()`). Poll, scan, register, keypad, tamper, logs and firmware download all require it; failures are logged as `Auth Rejection … (missing_key|bad_key|unknown_device)`.
- **Registration** (poll from an unknown MAC with `?email=`): only to a **verified** account, and the key is bound in the same INSERT. A second party that knows the MAC cannot take the device over — its key won't match.
- **Migration of deployed devices (TOFU):** a device registered before this change has `device_key_hash = NULL`. The first poll that carries a key binds it (`UPDATE … WHERE device_key_hash IS NULL`, so exactly one key wins). Until `LEGACY_DEVICE_AUTH=off`, devices without any key are still admitted — they need to reach the server to take the OTA that gives them a key. They receive no queued commands (they wouldn't understand them). **Residual risk during the transition:** someone who knows a legacy device's MAC could bind their own key first; the real device is then rejected (401) — denial of service, not takeover. The owner fixes it with `POST /api/devices/reset_key`. Switch `LEGACY_DEVICE_AUTH=off` as soon as the fleet runs the new firmware.
- `/api/device/provision` (bound any MAC to any `ownerId`, no auth, unused by the firmware) and `POST /api/log` (attributed entries by source IP = the proxy) are removed.

### 7.3 Command queue — how changes reach the device
- Card and WiFi changes are rows in **`device_commands`** and ride back in the poll response (`"cmds":"12:A|ABCDEF12|0;13:D|11223344"`, max 5 per poll). The device executes them on core 1 (`applyPendingCommands()`), persists, and confirms with `ack=<highest id>` in the next poll; the server marks them `acked_at`.
- Formats: `A|<uid8>|<0/1>` active, `D|<uid8>` delete, `N|<uid8>|<name hex, ≤15 B>` rename, `S|<uid8>|<en>|<days>|<start>|<end>` schedule, `W|<ssid hex>|<pass hex>` WiFi (device restarts only after the server has the ack).
- **Cards are addressed by UID (first 4 bytes), not by slot**, and commands carry the target state (not "toggle") — re-delivery is harmless and deleting one card cannot shift the target of the next command. Unknown UIDs are ignored and still acked.
- Replaces `syncMutationToHardware()`, which made the server open plain HTTP to `last_known_ip` (a private address in the customer's LAN) with the MAC-derived password: it only ever worked on the server's own LAN, and a spoofed `ip=` in the poll turned it into SSRF. `last_known_ip` is now informational (private IPv4 only).
- **The remote-unlock queue is per device only.** The former `unlockQueues['00:00:00:00:00:00']` wildcard was checked by every device's poll, so one customer's remote unlock opened the first other customer's door that polled within 8 s.
- Retention: acked commands are purged after 7 days (a `W` command contains the WiFi password in hex), orphaned ones after 30.

### 7.4 Accounts and sessions
- **Rate limiting works now.** `checkRateLimit()` had `store[ip].count;` without `++` — no limit (login, reset, invites) ever triggered. Limits are per real client IP: behind NPM the server takes `X-Real-IP`, but only from `TRUSTED_PROXIES`.
- **One-time codes** (email verification, reset, deregistration, account deletion, invites) come from `crypto.randomInt`. **Reset and verification codes are burned after 5 wrong guesses**; code checks are also limited to 30 / 15 min per IP; reset requests to 5/h per IP and per email. Deregistration / account-deletion codes likewise die after 5 wrong attempts.
- **`token_version`:** the JWT carries `tv`; `requireAuth` (now async) rejects tokens whose version differs from `accounts.token_version`, and tokens of deleted accounts. A password change or reset increments it → every other session is logged out. Changing the password requires the current one.
- **`JWT_SECRET` has no default** — the server exits at startup if it is missing or shorter than 32 chars (a known default secret = anyone can forge any account's token). JWTs are verified with `algorithms: ['HS256']`.
- Minimum password length **8** (register, reset, change, invite page). Request bodies are capped at 64 KB (413).
- Only the **owner** may change a device's WiFi (co-admins could previously cut the device off the network).

### 7.5 Signed firmware
- **ECDSA P-256.** The private key exists only as the GitHub secret `FIRMWARE_SIGNING_KEY` (and in an offline backup). The public key is compiled into the firmware (`FIRMWARE_PUBKEY_PEM`).
- `compile-ESP32.yml` signs `lock_<version>.bin` → `lock_<version>.bin.sig` and, before publishing, verifies the signature against the public key extracted from `access_control.ino`. No secret → no release.
- `/api/ota/push` requires a JWT, arms OTA **per device** (`otaPendingDevices[mac]`) for devices the account can access, and refuses releases without `.sig`. `/api/lock/download-firmware` serves the image only to an authenticated device with armed OTA and sends the signature in `X-Firmware-Signature`.
- The firmware hashes the image while writing it, verifies the signature before `Update.end()`, and aborts on mismatch (`[OTA PULL ERR] Podpis firmware NIEPRAWIDLOWY`). A compromised server or GitHub account can no longer push code to the locks.
- The old UNO R4 workflow (`compile.yml`, auto-released unsigned builds on `v*` tags) is manual-only now.
- **Rotating the signing key** needs one transitional release signed with the *old* key that contains the *new* public key; after that, sign with the new key.

### 7.6 RFID cards — UID cloning (residual risk)
Cards are matched on the 4-byte UID only. UID-only cards/fobs (MIFARE Classic, generic 125 kHz-style fobs) can be copied onto a "magic" card with a cheap reader in seconds, e.g. from a pocket. **This is not fixable in software on the current reader** — it needs cards with cryptographic authentication (MIFARE DESFire EV2/EV3) and a reader/firmware that performs it. Mitigations in place: UIDs are no longer sent to the app or exposed by the local API; blocking a card is delivered reliably (§7.3); schedules limit when a copied card works. Customers should be told about this limitation.

### 7.7 Repository and deployment
- **Make the GitHub repository private.** It is public; its history contains an old GitHub PAT and an old plain-text DB password. Both must be revoked/rotated (verify at github.com/settings/tokens and §4.4); if the old DB password was ever reused elsewhere, change it there too. Deleting files does not remove them from history.
- **`deploy.yml`** pins the server's SSH host key (`SERVER_KNOWN_HOSTS` secret, `StrictHostKeyChecking=yes`, previously `no`) and runs in the GitHub environment **`production`** — configure *Required reviewers* there so a push no longer deploys without approval. It also refuses to finish if the `count++` fix is missing.
- Every push to `main` touching `Server_app/server.js` deploys to production — keep that in mind before pushing.

### 7.8 Rollout checklist for the 2026-09-11 changes (order matters)
1. **GitHub secrets:** `FIRMWARE_SIGNING_KEY` (content of `firmware_signing_private.pem`, kept outside the repo) and `SERVER_KNOWN_HOSTS` (`ssh-keyscan -p 22044 <host>`, fingerprint checked against `/etc/ssh/ssh_host_ed25519_key.pub` on the server). Optionally the `production` environment with reviewers.
2. **Server `.env`:** confirm `JWT_SECRET` (≥ 32 chars) exists — otherwise the new server will not start. Keep `LEGACY_DEVICE_AUTH` unset (= on) for now.
3. **Deploy `server.js`**, then check `grep Migration /var/log/smartlock/smartlock_system.log | tail -3` — the new `device_key_hash`, `token_version` and `device_commands` must be created (table ownership, §3.5). Existing app sessions keep working (tokens issued before the change carry no `tv` and count as version 0).
4. **Push the firmware** → signed release → trigger OTA per device from the app. After the update each device binds its key on the first poll (`Przypięto klucz urządzenia` in the log). Pending card commands queued meanwhile are delivered right after.
5. **Offline-standalone devices** can only be updated over USB, and after the update their old local password and the (now WPA2) AP password are unknown to the app: do a **factory reset and set them up again** (the OLED then shows the AP password).
6. When every device shows a bound key (`SELECT mac_address FROM devices WHERE device_key_hash IS NULL;` returns nothing), set `LEGACY_DEVICE_AUTH=off` and restart.
7. Make the repository private and revoke the old PAT (§7.7). Ship the app build (SecureStore, password change, dev-only installer menu, service screen, self-test).
8. Set `SERVICE_ACCOUNTS` in `.env` (default `ctrlablenode@gmail.com`), enable **2FA on that Gmail** and give it a strong app password — it is the only account that can open service mode (§7.15).

### 7.9 Firewall (UFW on smartlock-backend)
```bash
ufw status
# 3000 ALLOW from 192.168.0.102   # NPM proxy ONLY
# 8081 ALLOW from 192.168.0.102   # NPM app proxy
# 22   ALLOW from 192.168.0.0/24  # SSH from LAN
```
**Tightened Aug 13 2026 (hardening step #2):** 3000 now accepts **only** from NPM (192.168.0.102). The old `3000 ALLOW from 192.168.0.76 (ESP32)` and `192.168.0.1 (hairpin NAT)` rules were removed, and the router's port-3000 forward was deleted (§2.3) — because the ESP32 now reaches the server over TLS via 443 → NPM → 3000, so nothing needs raw 3000 except NPM itself. The old unencrypted-transport internet exposure is closed. (The deploy workflow reaches SSH on port 22044 — keep it key-only and covered by fail2ban.)

### 7.10 Fail2ban (on Proxy, 192.168.0.102)
```bash
fail2ban-client status nginx-4xx
```
Jail config must point at `/opt/npm/data/logs/*_access.log` (the real bind-mount path), not a Docker volume UUID.

### 7.11 Tailscale
```bash
tailscale status
```
See §6.2 for the LXC host-side TUN config needed to run it inside this privileged container.

### 7.12 Rate limiting
Two layers: NPM (`limit_req`, §2.4) and, since 2026-09-11, a **working** application layer (§7.4). NPM's zone can silently disappear when the proxy host is recreated — the app layer no longer depends on it.

### 7.13 Credential rotation
All in `.env`. Edit, `pm2 restart ctrlable-server` — `override: true` means no other steps needed for the server to pick it up. Rotating `JWT_SECRET` logs everyone out.

### 7.14 Keys and secrets — what exists and where it comes from
| Secret | Generated by | Stored | Purpose |
|---|---|---|---|
| License codes | `licensekey.js` on the server | `license_codes` | Redeemed in the app — procedure in `LICENSING.md` §6.1 |
| Device key | firmware, first boot (HW RNG) | device NVS `dkey`; server keeps SHA-256 only | Device → server authentication (§7.2) |
| `CTRLABLE_SETUP` password | firmware, first boot | device NVS `appw` | WPA2 of the setup/offline AP (§7.1) |
| Local admin password | firmware, each offline setup | device EEPROM @400; app SecureStore | Offline-mode local API (§7.1) |
| Firmware signing key | `openssl ecparam -name prime256v1` (once) | GitHub secret + offline backup; **never in the repo** | Signs releases (§7.5) |
| Licence signing key | `openssl ecparam -name prime256v1` (once) | producer's machine + offline backup; **never in the repo**; public key in firmware `LICENSE_PUBKEY_PEM` | Signs offline licence tokens (§5.12) |
| `JWT_SECRET` | `openssl rand -hex 32` | server `.env` | Signs app sessions (§7.4) |

### 7.15 Service access — no standing backdoor, no service role in the DB

**Design (2026-09-11).** Service is an ordinary account listed in `SERVICE_ACCOUNTS` (default `ctrlablenode@gmail.com`). It has **no standing access to anything**: a customer invites it like any co-admin ("🛠️ Zaproś serwis" in *Zespół*), and only that device, only until the share expires. There is no service password in firmware, nothing computable from a MAC, and nothing reachable without the customer's grant — a leaked service login exposes at most the devices that share to it *at that moment*, and even those only for co-admin actions (see the two levels below). Only the owner can invite, so a leaked account cannot grant itself access anywhere.

**What makes a service share different**
- **Outside the admin limit.** `POST /api/devices/invite` skips `max_admins` when the invitee is a service address, and neither service shares nor service invites are counted for anyone else — a customer at the free tier's 2 admins never has to remove a co-admin to let service in. `enforceLicenseLimits()` never revokes a service share either.
- **It expires by itself** — `device_shares.expires_at = now + SERVICE_SHARE_HOURS` (48 h). `SHARE_ACTIVE` is part of every access query, so an expired share is dead immediately, not only after the daily purge. Re-inviting refreshes the expiry.
- **It can be ended by either side:** owner → *Odbierz*; service → `POST /api/devices/leave` ("Zakończ dostęp serwisowy"). Both are logged as `system_events`.

**Two levels inside a service share**
1. *Co-admin level* — what the share itself grants (unlock, cards, PINs, logs): available as soon as the invite is accepted.
2. *Service level* — diagnostics with the card list, relay test, restart, device-key reset: only in a **confirmed service session**, which requires being physically at the device:
   - `POST /api/service/start {mac}` → the server draws a 6-digit code (`crypto.randomInt`), queues `V|<code>` and the device shows it on the OLED for 15 min (`TRYB SERWISOWY / Kod do aplikacji`). Since v3.2.2 / Sep 15 2026 the server also queues an empty `V|` — which the firmware treats as "restore the normal screen" — as soon as the code is confirmed, the session ends, the code is burned, the service account leaves or the owner revokes it; v3.2.1 and older also hide the code on an empty `V|` (the field becomes an empty string), just with a confirmation click and a misleading log line. The code is never returned to the app and never logged. The owner gets a push: *"Serwisant rozpoczął sesję…"*.
   - `POST /api/service/confirm {mac, code}` → session confirmed for 60 min; 5 wrong codes burn it.
   - `POST /api/service/command {mac, action}` → `diagnostics` (`G|1`), `relay_test` (`G|2`, **opens the door for 0.4 s** — the app asks for confirmation), `restart` (`R`, executed after the ack like a WiFi change). `POST /api/devices/reset_key` also accepts a confirmed session.
   - `GET /api/service/report?mac=` → the latest report (`device_reports`): raw values (RFID chip version register, OLED, LittleFS mount/self-test/usage, keypad rows at rest, tamper, RSSI, NTP, heap free/min, uptime, `esp_reset_reason`), the same plain-language checks the customer sees, and the **device↔DB card comparison** (only-on-device / only-in-DB / active mismatch, by full UID server-side; the app shows only the last 4 hex chars). This replaces the local `/api/data` inspection that was removed in §7.1 and is what §5.8 drift diagnosis now runs on.
   Only accounts in `SERVICE_ACCOUNTS` see the *Serwis* screen — and the server enforces the same list, so a customer cannot enter service mode by accident or on purpose.

**Customer self-test** — `POST /api/devices/selftest {mac}` (owner or co-admin, 1/min) queues `G|0`; the device answers with the same report **minus the card list and minus the relay test**. `GET /api/devices/selftest?mac=` returns `checks[]`, a one-line `summary` and `serviceRecommended` when any check fails ("Wykryto problem: Klawiatura. Zalecany kontakt z serwisem."). Reports are data from the device, so the server whitelists fields and types (`sanitizeDeviceReport`) and keeps the last 5 per device (30-day retention).

**Firmware side.** Commands `V|<code>` (show code), `G|<mode>` (build report on core 1 → `buildDiagnosticReport()`, sent by `networkTask` via `POST /api/hardware/diag` with the device key), `R` (restart after ack). The report includes `WiFi.RSSI()`, `ESP.getFreeHeap()/getMinFreeHeap()`, `esp_reset_reason()` and reads the MFRC522 `VersionReg` (0x91/0x92 = reader present; 0x00/0xFF = no SPI answer).

**Residual points.** One shared service login means no per-technician attribution — fine for a one-person service; when there are several technicians, list one address per person in `SERVICE_ACCOUNTS` (the same design, better audit). Protect the Gmail with 2FA and rotate the app password when someone leaves. The service account is deliberately **not** stored as a role in the database — adding or removing one is a `.env` edit plus restart, never a per-visit change.

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
1. Does `https://node.ctrlable.pl` answer from outside (NPM up, Let's Encrypt cert valid — the firmware pins ISRG Root X1, §5.2)? Port 3000 is **not** forwarded any more (§2.3); only 80/443 → NPM. (Historically a missing 3000 forward cost a whole debugging session — that path no longer exists.)
2. Is `pm2` running `ctrlable-server`? `pm2 list`
   Is the device polling at all? The poll is **not** logged per request (the old 60 s trace was removed 2026-09-11 — noise + the owner's e-mail in every line). Check `devices.last_heartbeat`, or `grep Heartbeat /var/log/smartlock/smartlock_system.log | tail`, which logs only state changes: first poll after a server start, *wróciła online po N s*, *Zmiana firmware: a → b*, and *przestała odpytywać* (one line per outage, from a 30 s watchdog).
3. Test from the server itself: `curl -s http://192.168.0.199:3000/api/hardware/poll?mac=test` — **400 is the healthy answer now** (invalid MAC); a device-level `401` in the log means a key problem (§7.2), not connectivity.
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

### 8.9 WiFi change / card change from the app "does nothing"
Since 2026-09-11 both go through the command queue (§7.3). Check in order:
1. `SELECT id, cmd, delivered_at, acked_at FROM device_commands WHERE mac_address='<MAC>' ORDER BY id DESC LIMIT 10;` — `delivered_at` NULL = the device isn't polling (offline) or is on old firmware (legacy devices get no commands — update them).
2. Delivered but never acked → the device received the batch but is not confirming; check the serial log for `[CMD]` / `Serwer odrzucil klucz`.
3. WiFi change: only the owner may do it (403 for co-admins); SSID and password max. 31 characters; the device restarts only after its ack reached the server.
4. **Do not** reintroduce a server → device HTTP call or run the setup server while online — both were security holes (§7.1).

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

### 8.14 Device gets 401 on every poll
The server rejects its key (`Auth Rejection … bad_key` in the log). Causes: the board was replaced or its NVS was erased (new key), or during the migration window another party bound a key to that MAC first. Fix: the owner calls **`POST /api/devices/reset_key {mac}`** (or in SQL: `UPDATE devices SET device_key_hash = NULL WHERE mac_address='<MAC>';`) — the device binds its current key on the next poll.
---

## 9. Known Open Items (not yet built — see also the standalone roadmap PDF)

- **Service access + self-test — DONE (2026-09-11, §7.15):** invite-based, outside the admin limit, expiring, OLED code for on-site confirmation. Not yet on hardware: relay test timing (0.4 s) and OLED layout of the service code should be checked on one unit.
- **Security audit 2026-09-11 — code fixes DONE (§7); operational steps OPEN (§7.8):** GitHub secrets, repository private, old PAT revoked, `LEGACY_DEVICE_AUTH=off` after the fleet update, `production` environment reviewers. **Residual risks by design:** UID-only RFID cards can be cloned (§7.6, needs DESFire hardware); legacy-device key binding is trust-on-first-use during the transition (§7.2).

- **RFID schedule enforcement — DONE (Aug 18 2026, §5.7).** Schedules sync to the device and are checked locally before unlocking. Remaining gap: they are pushed only when changed in the app, so pre-existing schedules (or a factory-reset device) need one re-save; there is no reconciliation sweep yet.
- ~~**ESP32 firmware transport is unencrypted HTTP**~~ — **migrated to TLS in firmware (Aug 13 2026, §5.2):** `WiFiClientSecure` on 443 through NPM, root-CA pinned. ISRG Root X1 PEM is embedded in `ROOT_CA_LE`. Fully closed: TLS bench-tested and verified in the field (§5.2), router port-3000 forward removed (§2.3).
- **EEPROM/database sync has no automatic reconciliation** (§5.8) — currently a manual process if they drift.
- **LittleFS card storage — DONE (Aug 17 2026), verified on hardware** (`[FS] LittleFS OK … selftest=PASS`). Cards live in `/cards.db`, cap raised 10 → **200**, with EEPROM fallback if the mount fails (§5.4). It deployed over normal OTA as predicted — the default `esp32:esp32:esp32` partition scheme already has a `spiffs` partition, so no partition change / USB / re-provision was needed; `partitions.csv` remains an unused fallback.
- **Local (offline) PIN verification — STILL OPEN** (stage 2). PINs are verified server-side, so they don't work offline and the check is one of the last blocking TLS calls left in `loop()` (§5.2b). *(Its security aspect — anyone knowing the MAC could brute-force PINs remotely through `/api/auth/keypad` — is closed by the device key, §7.2; what remains is the availability/latency feature.)* Plan: PBKDF2-HMAC-SHA256 hashes in `/pins.db` (struct already defined and sized). Full model in `LICENSING.md`.
- ~~**Offline license key (future idea)**~~ — **BUILT 2026-09-11, WITHDRAWN FROM SALE 2026-09-14 (§5.12, dormant):** signed per-device token, perpetual, same tiers as online; the free offline cap of 2 cards is now enforced in firmware. Not yet tested on hardware. Remaining: offline PIN verification (below), prices.
- ~~**Keypad PINs are account-scoped, not device-scoped**~~ — **FIXED (Aug 13, 2026).** `keypad_pins` now has a `mac_address` column; PINs are scoped per centralka and verify by `mac_address` (any PIN on a device verifies regardless of which account — owner or co-admin — created it). Add/list/manage authorize by device access (owner OR co-admin via `device_shares`). See §4.1.
- ~~Data export / account deletion~~ — **DONE (Sep 2026):** `GET /api/account/export`, `POST /api/account/delete_request|confirm` with device factory reset and an `erasure_requests` tombstone (§3.6, `LICENSING.md` §6.0). Still open: 2FA for the app login; firmware `BTN_NC`/`BTN_LED` for the custom PCB (§5.1b); PN532 reader with DESFire for clone-resistant cards (evaluation). The old "features PDF" is superseded by this list.

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

# Test server health (401 = healthy: proxy + backend answer, no token given)
curl -s -o /dev/null -w "%{http_code}\n" https://node.ctrlable.pl/api/data

# Devices still without a bound device key (must be empty before LEGACY_DEVICE_AUTH=off, §7.2)
psql -h localhost -U admin smartlock_db -c "SELECT mac_address, firmware_version, last_heartbeat FROM devices WHERE device_key_hash IS NULL;"

# Commands waiting for devices (§7.3)
psql -h localhost -U admin smartlock_db -c "SELECT mac_address, COUNT(*) FROM device_commands WHERE acked_at IS NULL GROUP BY mac_address;"

# Test with auth
TOKEN=$(curl -s -X POST https://node.ctrlable.pl/api/auth/login -H "Content-Type: application/json" -d '{"email":"ctrlablenode@gmail.com","password":"YOUR_PASSWORD"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('token','MISSING'))")
curl -s https://node.ctrlable.pl/api/data -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

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
