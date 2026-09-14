require('dotenv').config({ path: '/opt/smartlock-server/.env', override: true });
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');

// Publiczny adres bazowy serwera (przez NPM/HTTPS) — używany do budowania
// linków zaproszeń współadministratorów wysyłanych mailem. Ten sam host, co
// backendUrl aplikacji. Nadpisywalny zmienną środowiskową PUBLIC_BASE_URL.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://node.ctrlable.pl';

// Linki prawne pokazywane na stronie zaproszenia (/invite). Strony jeszcze nie
// istnieją — to placeholdery, podmień na docelowe adresy (lub ustaw przez env),
// gdy Regulamin i Polityka Prywatności zostaną opublikowane.
const TERMS_URL   = process.env.TERMS_URL   || 'https://ctrlable.pl/regulamin.html';
const PRIVACY_URL = process.env.PRIVACY_URL || 'https://ctrlable.pl/polityka-prywatnosci.html';

// Retencja/minimalizacja danych (RODO art. 5): po ilu dniach kasować rejestr
// zdarzeń (system_events). 0 lub puste = wyłączone (trzymaj bez limitu).
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '90', 10);

// ─── Security packages ────────────────────────────────────────────────────────
// Install once on the server:
//   npm install jsonwebtoken express-rate-limit helmet
let jwt, RateLimiter;
try {
  jwt = require('jsonwebtoken');
} catch(e) {
  console.warn('[SECURITY] jsonwebtoken not installed — JWT auth disabled. Run: npm install jsonwebtoken');
  jwt = null;
}
try {
  const { RateLimiterMemory } = require('rate-limiter-flexible');
  RateLimiter = RateLimiterMemory;
} catch(e) {
  // Fallback: simple in-process counter when rate-limiter-flexible is unavailable
  RateLimiter = null;
}

// =========================================================================
// GLOBAL PLATFORM CONFIGURATION SPACE
// =========================================================================

const HARDWARE_OTA_USER = 'admin';

// OTA release version
let latestFirmwareReleaseId = 0;


// ─── GitHub PAT ───────────────────────────────────────────────────────────────
// NEVER hard-code this. Set the env variable on your Proxmox server:
//   export GITHUB_PAT="ghp_your_new_token_here"
// The old token that was in source has been exposed and MUST be rotated at:
//   https://github.com/settings/tokens
const GITHUB_PAT  = process.env.GITHUB_PAT  || '';
const GITHUB_USER = process.env.GITHUB_USER  || "pepiuspl";
const GITHUB_REPO = process.env.GITHUB_REPO  || "ArduinoR4wifi-Access-control";

if (!GITHUB_PAT) {
  console.warn('[SECURITY] GITHUB_PAT env variable not set — OTA firmware checks will fail.');
}

// ─── JWT configuration ────────────────────────────────────────────────────────
// Set a strong random secret:  export JWT_SECRET=$(openssl rand -hex 32)
// BEZ DOMYŚLNEJ WARTOŚCI: znany sekret = każdy może podpisać token dowolnego konta.
// Serwer bez poprawnego sekretu NIE STARTUJE (fail-closed) zamiast działać dziurawo.
const JWT_SECRET  = process.env.JWT_SECRET || '';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';   // token lifetime

if (JWT_SECRET.length < 32 || JWT_SECRET === 'CHANGE_ME_set_JWT_SECRET_env_variable') {
  console.error('[FATAL] Brak JWT_SECRET (min. 32 znaki) w /opt/smartlock-server/.env — serwer nie wystartuje bez sekretu. Wygeneruj: openssl rand -hex 32');
  process.exit(1);
}

// ─── CORS allowlist ───────────────────────────────────────────────────────────
// List every origin that is allowed to call this API.
// For a React Native app (Expo) the origin is the dev server or the app bundle;
// add your actual domains here. 'null' covers file:// bundled Expo builds.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
// Always allow localhost variants for development
const DEV_ORIGINS = ['http://localhost:8081','http://localhost:19000','http://localhost:19006'];
const ALL_ALLOWED = new Set([...ALLOWED_ORIGINS, ...DEV_ORIGINS]);

function isOriginAllowed(origin) {
  if (!origin) return true;       // non-browser clients (ESP32, curl) have no Origin
  if (ALL_ALLOWED.has(origin)) return true;
  // Expo Go on device sends null or exp:// scheme — allow it for dev
  if (origin === 'null' || origin.startsWith('exp://')) return true;
  return false;
}

// ─── Rate limiters (simple token-bucket per IP) ───────────────────────────────
// Login:           max 10 attempts per 15 min per IP
// Forgot-password: max 5 requests per 60 min per IP
const loginAttempts   = {};   // { ip: { count, resetAt } }
const forgotAttempts  = {};
const inviteAttempts  = {};
const codeCheckAttempts = {}; // sprawdzanie kodów 6-cyfrowych (reset, weryfikacja e-mail), per IP
const forgotPerEmail  = {};   // prośby o kod resetu, per adres e-mail
const registerAttempts = {};  // zakładanie kont (i ponowne wysyłanie kodu), per IP
const selftestAttempts = {};  // self-test centralki, per MAC (raz na minutę)

function checkRateLimit(store, ip, maxHits, windowMs) {
  const now = Date.now();
  if (!store[ip] || now > store[ip].resetAt) {
    store[ip] = { count: 0, resetAt: now + windowMs };
  }
  // UWAGA: tu przez długi czas stało samo `store[ip].count;` (bez ++) — licznik nigdy
  // nie rósł i ŻADEN limit (logowanie, reset hasła, zaproszenia) nie działał. README §3.4
  // opisuje to jako błąd nawracający przy podmianie pliku — sprawdzaj po każdym deployu.
  store[ip].count++;
  if (store[ip].count > maxHits) {
    const retryAfterSec = Math.ceil((store[ip].resetAt - now) / 1000);
    return retryAfterSec;   // seconds to wait
  }
  return 0;   // allowed
}

// Kody jednorazowe (weryfikacja e-mail, reset hasła, deregistracja, usunięcie konta,
// zaproszenie) z generatora KRYPTOGRAFICZNEGO — Math.random() jest przewidywalny.
function genCode6() {
  return crypto.randomInt(100000, 1000000).toString();
}

// Limit błędnych prób dla KONKRETNEGO kodu. Po CODE_MAX_ATTEMPTS pomyłkach kod jest
// unieważniany, więc zgadywanie 6 cyfr (1 : 900 000) przestaje mieć sens — trzeba
// poprosić o nowy kod, a te są limitowane per IP i per e-mail.
const CODE_MAX_ATTEMPTS = 5;
const codeFailures = {};   // klucz (np. "reset:jan@x.pl") -> liczba pomyłek
function codeFailed(key) {
  codeFailures[key] = (codeFailures[key] || 0) + 1;
  return codeFailures[key] >= CODE_MAX_ATTEMPTS;   // true = kod właśnie spalony
}
function codeReset(key) { delete codeFailures[key]; }

// Minimalna długość hasła konta — jedna wartość dla rejestracji, resetu, zmiany
// hasła i akceptacji zaproszenia (aplikacja pokazuje tę samą liczbę).
const MIN_PASSWORD_LENGTH = 8;

// Serwer stoi za Nginx Proxy Managerem, więc socket zawsze pokazuje adres proxy.
// Prawdziwy adres klienta bierzemy z X-Real-IP — ale TYLKO gdy żądanie przyszło
// od zaufanego proxy; od kogokolwiek innego nagłówek byłby do podrobienia.
const TRUSTED_PROXIES = (process.env.TRUSTED_PROXIES || '192.168.0.102')
  .split(',').map(s => s.trim()).filter(Boolean);

// ─── Konta serwisowe (README §7.15) ──────────────────────────────────────────
// Serwis NIE ma stałego dostępu do żadnej centralki. Klient zaprasza konto z tej
// listy jak zwykłego współadmina; udział jest oznaczony `is_service`, NIE liczy się
// do limitu administratorów pakietu i WYGASA sam po SERVICE_SHARE_HOURS. Rozszerzone
// akcje serwisowe wymagają dodatkowo potwierdzenia kodem wyświetlonym na OLED
// centralki (obecność fizyczna). Lista w .env: SERVICE_ACCOUNTS=a@x.pl,b@x.pl
const SERVICE_ACCOUNTS = new Set((process.env.SERVICE_ACCOUNTS || 'ctrlablenode@gmail.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const SERVICE_SHARE_HOURS = parseInt(process.env.SERVICE_SHARE_HOURS || '48', 10) || 48;
const isServiceEmail = (email) => SERVICE_ACCOUNTS.has(String(email || '').trim().toLowerCase());
// Udział aktywny = bez daty wygaśnięcia albo jeszcze przed nią (udziały serwisowe).
const SHARE_ACTIVE = `(expires_at IS NULL OR expires_at > NOW())`;
// serviceSessions[mac] = { accountId, code, codeUntil, confirmedUntil, fails }
const serviceSessions = {};

// Aktualizacja uzbrojona per centralka (mac -> timestamp). Wcześniej jedna globalna
// flaga: kliknięcie „Aktualizuj" przez dowolnego klienta aktualizowało WSZYSTKIE zamki.
const otaPendingDevices = {};
const firmwareVersionCache = { value: null, at: 0, inflight: null };
let latestFirmwareVersion = "2.9.7";
let latestFirmwareFile = "";
const updatesDir = '/opt/smartlock-server/updates';

// CONNECT TO THE RELATIONAL POSTGRESQL ENGINE
// Dane dostępowe TYLKO ze zmiennych środowiskowych (/opt/smartlock-server/.env) —
// żadnych sekretów w kodzie/repo. Hasło NIE ma fallbacku: musi być w .env.
if (!process.env.DB_PASSWORD) {
  console.error('[FATAL] Brak DB_PASSWORD w /opt/smartlock-server/.env — ustaw je przed startem serwera.');
}
const dbPool = new Pool({
  user:     process.env.DB_USER     || 'admin',
  host:     process.env.DB_HOST     || 'localhost',
  database: process.env.DB_NAME     || 'smartlock_db',
  password: process.env.DB_PASSWORD,
  port:     parseInt(process.env.DB_PORT || '5432', 10),
});

// Local Postfix delivery service
const mailTransport = nodemailer.createTransport({
  host: '127.0.0.1',
  port: 25,
  secure: false,
  ignoreTLS: true,
  auth: null
});

// LOCAL FILE LOGGING ENVIRONMENT INITIALIZATION
const logDirectory = '/var/log/smartlock';
const localLogFile = path.join(logDirectory, 'smartlock_system.log'); // master log — everything, unchanged

// Categorized subfolders for scalable log browsing as device count grows.
// Each module name maps to exactly one category folder.
const LOG_CATEGORIES = {
  entries:     ['API Control Command', 'Hardware Handshake', 'Access Granted', 'Access Denied', 'Keypad', 'Keypad RateLimit', 'Keypad ERROR', 'Hardware Ingest'],
  connections: ['Radar Traffic', 'Authentication Panel', 'Auth Rejection', 'Auth RateLimit', 'Core Daemon', 'Heartbeat'],
  updates:     ['DEBUG OTA PUSH', 'DEBUG LOCK DOWNLOAD', 'DEBUG GITHUB', 'Hardware Remote Log'],
  security:    ['TAMPER', 'CORE PANIC RECOVERY BOUNDARY', 'Push Diagnostic', 'Push Notification Error', 'Push System Warning'],
  provisioning:['Provisioning', 'Settings Update', 'User Mutation', 'Reset System', 'Service', 'License', 'Hardware Registration'],
  mail:        ['SMTP Handshake Matrix', 'Welcome SMTP Fail', 'Błąd serwera SMTP', 'Push System'],
};
// Reverse lookup: module name -> category folder name
const MODULE_TO_CATEGORY = {};
for (const [cat, modules] of Object.entries(LOG_CATEGORIES)) {
  for (const m of modules) MODULE_TO_CATEGORY[m] = cat;
}
const LOG_SUBDIRS = Object.keys(LOG_CATEGORIES);

if (!fs.existsSync(logDirectory)) {
  fs.mkdirSync(logDirectory, { recursive: true });
}
for (const sub of LOG_SUBDIRS) {
  const subPath = path.join(logDirectory, sub);
  if (!fs.existsSync(subPath)) fs.mkdirSync(subPath, { recursive: true });
}
const UNCATEGORIZED_DIR = path.join(logDirectory, 'uncategorized');
if (!fs.existsSync(UNCATEGORIZED_DIR)) fs.mkdirSync(UNCATEGORIZED_DIR, { recursive: true });

function writeToLocalLogFile(module, message) {
  const timestamp = new Date().toISOString();
  const rawLogLine = `[${timestamp}] [${module}] ${message}\n`;

  // Master log — always written, unchanged behavior for backward compatibility.
  fs.appendFile(localLogFile, rawLogLine, (err) => {
    if (err) console.error(`[Logging Fault] Failed to write to disk: ${err.message}`);
  });

  // Categorized log — one file per day per category, e.g. entries/2026-07-08.log
  const category = MODULE_TO_CATEGORY[module] || null;
  const dateStamp = timestamp.slice(0, 10); // YYYY-MM-DD
  const targetDir = category ? path.join(logDirectory, category) : UNCATEGORIZED_DIR;
  const targetFile = path.join(targetDir, `${dateStamp}.log`);
  fs.appendFile(targetFile, rawLogLine, (err) => {
    if (err) console.error(`[Logging Fault] Failed to write category log: ${err.message}`);
  });
}

// Generowanie unikalnego admin pass

// Wybiera urządzenie docelowe dla danego konta: jeśli klient poda ?mac=
// (lub w body dla POST), i to urządzenie należy do tego konta - używamy go.
// W przeciwnym razie (stare wywołania z aplikacji bez wsparcia multi-device)
// zachowujemy pełną wsteczną kompatybilność, wracając do pierwszego
// urządzenia na koncie - dokładnie tak jak działało to wcześniej.
// Konto ma dostęp do urządzenia jeśli jest jego WŁAŚCICIELEM (devices.account_id)
// LUB zostało ZAPROSZONE jako współadministrator (device_shares). Ten warunek
// jest wklejany do każdego zapytania poniżej zamiast prostego "account_id = $1",
// żeby zaproszeni administratorzy mieli te same możliwości odblokowywania,
// zarządzania PIN-ami/kartami itd. co właściciel.
const DEVICE_ACCESS_CONDITION = `(d.account_id = $1 OR d.mac_address IN (SELECT mac_address FROM device_shares WHERE account_id = $1 AND ${SHARE_ACTIVE}))`;

async function resolveTargetDevice(accountId, requestedMac, columns = 'mac_address, last_known_ip') {
  const cols = columns.split(',').map(c => `d.${c.trim()}`).join(', ');
  if (requestedMac) {
    const exact = await dbPool.query(
      `SELECT ${cols} FROM devices d WHERE ${DEVICE_ACCESS_CONDITION} AND d.mac_address = $2 LIMIT 1`,
      [accountId, requestedMac.toUpperCase()]
    );
    if (exact.rows.length > 0) return exact;
  }
  return dbPool.query(`SELECT ${cols} FROM devices d WHERE ${DEVICE_ACCESS_CONDITION} ORDER BY d.mac_address ASC LIMIT 1`, [accountId]);
}

// --- Egzekwowanie limitów pakietu na ISTNIEJĄCYCH poświadczeniach --------------
// Decyzja produktowa (18.08.2026), zastępuje wcześniejszy „grandfathering" z §3.4
// LICENSING.md: po spadku pakietu klient korzysta z TYLU poświadczeń, ile obejmuje
// jego pakiet — nadmiarowe przestają działać.
//
// Zasady wyboru, które zostają (ustalone z właścicielem produktu):
//   1. poświadczenia WSKAZANE PRZEZ KLIENTA (`keep_on_downgrade`) — mechanizm główny;
//      aplikacja prosi o ten wybór, zanim licencja wygaśnie,
//   2. karta/PIN oznaczony jako WŁAŚCICIELA — FALLBACK, gdy klient nic nie wybrał
//      (chroni przed zamknięciem właściciela przed własnym budynkiem),
//   3. potem najstarsze wg daty dodania,
//   4. reszta → dezaktywacja z `license_locked = true`.
//
// DEZAKTYWACJA, NIE KASOWANIE — po powrocie do wyższego pakietu przywracamy dokładnie
// te wpisy, które zablokował system (`license_locked`), nie ruszając tych, które
// właściciel zamroził świadomie. Dane nigdy nie giną przez samą zmianę pakietu.
async function enforceLicenseLimits(accountId) {
  try {
    const ent = await getEntitlements(accountId);
    const devs = await dbPool.query('SELECT mac_address FROM devices WHERE account_id = $1', [accountId]);

    for (const dev of devs.rows) {
      const mac = dev.mac_address;

      // --- KARTY: właściciel pierwszy, potem najstarsze wg id ---
      const cards = await dbPool.query(
        `SELECT id, card_uid, is_active, license_locked
           FROM card_credentials WHERE mac_address = $1
          ORDER BY keep_on_downgrade DESC, is_owner_card DESC, id ASC`, [mac]);

      for (let i = 0; i < cards.rows.length; i++) {
        const c = cards.rows[i];
        const withinLimit = i < ent.max_cards;

        // Stan karty trafia na centralkę przez kolejkę komend (odbiera ją przy pollu),
        // a nie przez HTTP na jej prywatne IP — tamto działało tylko w sieci serwera.
        if (!withinLimit && c.is_active) {
          await dbPool.query('UPDATE card_credentials SET is_active = false, license_locked = true, license_locked_at = COALESCE(license_locked_at, NOW()), license_delete_notice_sent = false WHERE id = $1', [c.id]);
          await queueCardCommand(mac, c.card_uid, 'A', '0');
          writeToLocalLogFile('License', `[Node: ${mac}] Karta id=${c.id} wyłączona — limit pakietu ${ent.license_tier} (${ent.max_cards}).`);
        } else if (withinLimit && c.license_locked && !c.is_active) {
          // Wróciliśmy w limit — przywracamy to, co zablokował system.
          await dbPool.query('UPDATE card_credentials SET is_active = true, license_locked = false, license_locked_at = NULL, license_delete_notice_sent = false WHERE id = $1', [c.id]);
          await queueCardCommand(mac, c.card_uid, 'A', '1');
          writeToLocalLogFile('License', `[Node: ${mac}] Karta id=${c.id} przywrócona po zwiększeniu pakietu.`);
        }
      }

      // --- PIN-y: ta sama zasada (weryfikacja jest serwerowa, więc bez sync do sprzętu) ---
      const pins = await dbPool.query(
        `SELECT id, active, license_locked FROM keypad_pins WHERE mac_address = $1
          ORDER BY keep_on_downgrade DESC, is_owner_pin DESC, created_at ASC, id ASC`, [mac]);

      for (let i = 0; i < pins.rows.length; i++) {
        const p = pins.rows[i];
        const withinLimit = i < ent.max_pins;
        if (!withinLimit && p.active) {
          await dbPool.query('UPDATE keypad_pins SET active = false, license_locked = true, license_locked_at = COALESCE(license_locked_at, NOW()), license_delete_notice_sent = false WHERE id = $1', [p.id]);
          writeToLocalLogFile('License', `[Node: ${mac}] PIN id=${p.id} wyłączony — limit pakietu ${ent.license_tier} (${ent.max_pins}).`);
        } else if (withinLimit && p.license_locked && !p.active) {
          await dbPool.query('UPDATE keypad_pins SET active = true, license_locked = false, license_locked_at = NULL, license_delete_notice_sent = false WHERE id = $1', [p.id]);
          writeToLocalLogFile('License', `[Node: ${mac}] PIN id=${p.id} przywrócony po zwiększeniu pakietu.`);
        }
      }

      // --- WSPÓŁADMINISTRATORZY: max_admins LICZY właściciela, więc miejsc jest (max-1).
      // Odbieramy dostęp NAJNOWSZYM — najstarsi współpracownicy zostają.
      const slots = Math.max(0, (ent.max_admins || 1) - 1);
      // Udziały serwisowe są poza limitem pakietu — ani nie zajmują miejsca, ani nie są odbierane.
      const shares = await dbPool.query(
        'SELECT id FROM device_shares WHERE mac_address = $1 AND is_service = false ORDER BY created_at ASC, id ASC', [mac]);
      if (shares.rows.length > slots) {
        const toRevoke = shares.rows.slice(slots).map(r => r.id);
        await dbPool.query('DELETE FROM device_shares WHERE id = ANY($1)', [toRevoke]);
        writeToLocalLogFile('License', `[Node: ${mac}] Odebrano dostęp ${toRevoke.length} współadministratorom — limit pakietu ${ent.license_tier}.`);
      }
    }
  } catch (e) {
    writeToLocalLogFile('Core Daemon', `[License] Błąd egzekwowania limitów dla konta ${accountId}: ${e.message}`);
  }
}

// --- Tożsamość karty RFID -----------------------------------------------------
// HISTORIA BŁĘDU: `/api/data` zwracało `idx` = hardware_slot_idx (slot w EEPROM/LittleFS),
// a endpointy mutacji używały `cards.rows[idx]`, czyli POZYCJI w liście. Te dwie rzeczy
// pokrywały się tylko przypadkiem — po resetach/ponownym dodaniu karty miały ten sam
// (albo pusty) slot, przez co zmiana nazwy/blokada/usunięcie trafiały w NIEWŁAŚCIWĄ kartę,
// a aplikacja renderowała zduplikowane klucze React. Od teraz jedyną tożsamością jest
// `card_credentials.id` (stabilne), a slot sprzętowy służy WYŁĄCZNIE do synchronizacji
// z centralką. `idx` obsługiwany dalej jako fallback dla starszych buildów aplikacji.
async function resolveCardRow(targetMac, body) {
  const cards = await dbPool.query(
    'SELECT id, card_uid, is_active, hardware_slot_idx FROM card_credentials WHERE mac_address = $1 ORDER BY id ASC',
    [targetMac]
  );
  if (body && body.id != null) {
    const wanted = parseInt(body.id, 10);
    return cards.rows.find(r => r.id === wanted) || null;
  }
  if (body && body.idx != null) return cards.rows[body.idx] || null;   // stara apka
  return null;
}

// Fragment SQL: zbiór MAC-ów, do których dane konto ma dostęp jako właściciel LUB
// współadmin. `param` to numer placeholdera (np. '$2'). Używane do autoryzacji
// operacji na PIN-ach po MAC-u urządzenia zamiast po koncie twórcy PIN-u.
function macAccessSubquery(param) {
  return `(SELECT mac_address FROM devices WHERE account_id=${param} UNION SELECT mac_address FROM device_shares WHERE account_id=${param} AND ${SHARE_ACTIVE})`;
}

// =========================================================================
// UWIERZYTELNIANIE CENTRALEK — klucz urządzenia (README §7.2)
// =========================================================================
// Dawniej jedynym „hasłem" centralki był jej MAC (widoczny w eterze), a hasło
// lokalnego API wyliczało się z MAC-a jawnym algorytmem z publicznego repo.
// Teraz każda centralka przy pierwszym starcie losuje 32-bajtowy klucz (NVS) i
// dołącza go do KAŻDEGO żądania w nagłówku X-Device-Key (po TLS). Serwer trzyma
// wyłącznie SHA-256 klucza (devices.device_key_hash).
//
// Przejście ze starego firmware: urządzenie zarejestrowane bez klucza przypina go
// przy pierwszym połączeniu z nowym firmware (trust-on-first-use, tylko gdy hash
// jest pusty). Dopóki LEGACY_DEVICE_AUTH != 'off', stare centralki bez klucza
// działają dalej — żeby mogły odebrać OTA z poprawką. Po aktualizacji całej floty
// ustaw LEGACY_DEVICE_AUTH=off w .env.
const LEGACY_DEVICE_AUTH = (process.env.LEGACY_DEVICE_AUTH || 'on').toLowerCase() !== 'off';
const legacyAuthLog = {};   // throttle logu „centralka bez klucza" (raz na godzinę per MAC)

function hashDeviceKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function readDeviceKey(req) {
  const k = String(req.headers['x-device-key'] || '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(k) ? k : '';
}

function normalizeMac(mac) {
  const m = String(mac || '').trim().toUpperCase();
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(m) ? m : '';
}

// Szuka centralki po MAC, tolerując odwróconą kolejność bajtów (jak dotąd w pollu).
async function findDeviceByMac(mac) {
  const m = normalizeMac(mac);
  if (!m) return null;
  const cols = 'mac_address, account_id, device_key_hash';
  let r = await dbPool.query(`SELECT ${cols} FROM devices WHERE mac_address = $1`, [m]);
  if (r.rows.length === 0) {
    r = await dbPool.query(`SELECT ${cols} FROM devices WHERE mac_address = $1`, [m.split(':').reverse().join(':')]);
  }
  return r.rows[0] || null;
}

// Wynik: { ok, mac, device, legacy, reason }. `mac` = MAC w postaci z bazy.
async function authenticateDevice(req, rawMac) {
  const device = await findDeviceByMac(rawMac);
  if (!device) return { ok: false, reason: 'unknown_device' };
  const key = readDeviceKey(req);

  if (device.device_key_hash) {
    if (!key) return { ok: false, reason: 'missing_key', device };
    const a = Buffer.from(hashDeviceKey(key), 'hex');
    const b = Buffer.from(device.device_key_hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_key', device };
    return { ok: true, mac: device.mac_address, device };
  }

  if (key) {
    // Przypięcie klucza — `IS NULL` w warunku sprawia, że wygrywa dokładnie jeden klucz.
    await dbPool.query(
      'UPDATE devices SET device_key_hash = $1 WHERE mac_address = $2 AND device_key_hash IS NULL',
      [hashDeviceKey(key), device.mac_address]);
    const again = await findDeviceByMac(device.mac_address);
    if (again && again.device_key_hash === hashDeviceKey(key)) {
      writeToLocalLogFile('Provisioning', `[Node: ${device.mac_address}] Przypięto klucz urządzenia (pierwsze połączenie z bezpiecznym firmware).`);
      return { ok: true, mac: device.mac_address, device: again };
    }
    return { ok: false, reason: 'bad_key', device: again };
  }

  if (LEGACY_DEVICE_AUTH) {
    const k = device.mac_address;
    if (!legacyAuthLog[k] || Date.now() - legacyAuthLog[k] > 3600 * 1000) {
      legacyAuthLog[k] = Date.now();
      writeToLocalLogFile('Provisioning', `[Node: ${k}] Centralka bez klucza urządzenia (stary firmware) — dopuszczona w trybie przejściowym. Zaktualizuj ją przez OTA.`);
    }
    return { ok: true, mac: device.mac_address, device, legacy: true };
  }
  return { ok: false, reason: 'missing_key', device };
}

function logDeviceAuthFailure(auth, rawMac, pathname, ip) {
  writeToLocalLogFile('Auth Rejection',
    `[Node: ${normalizeMac(rawMac) || rawMac || 'BRAK-MAC'}] Odrzucono żądanie centralki ${pathname} (${auth.reason}) z IP ${ip}.`);
}

// =========================================================================
// KOLEJKA KOMEND DLA CENTRALKI (README §7.3)
// =========================================================================
// Zmiany kart i Wi-Fi docierają do centralki w odpowiedzi na jej poll — tym samym
// kanałem TLS, którym przychodzi zdalne otwarcie. Wcześniej serwer łączył się po
// HTTP z PRYWATNYM IP centralki (last_known_ip), co działało wyłącznie w sieci
// serwera: u klienta blokada zgubionego breloka po cichu nie docierała.
//
// Komendy są trwałe (tabela device_commands), idempotentne i adresują kartę po UID,
// nie po numerze slotu — powtórne doręczenie niczego nie psuje, a usunięcie jednej
// karty nie przesuwa celów kolejnych komend. Centralka potwierdza wykonanie
// parametrem ack=<ostatnie id> w następnym pollu.
//   A|<uid8>|<0/1>                 aktywność karty
//   D|<uid8>                       usunięcie karty
//   N|<uid8>|<nazwa hex>           zmiana nazwy (max 15 bajtów UTF-8)
//   S|<uid8>|<en>|<dni>|<od>|<do>  harmonogram karty
//   W|<ssid hex>|<hasło hex>       nowa sieć Wi-Fi (centralka restartuje się po ack)
const DEVICE_CMD_BATCH = 5;

function uidToHex8(cardUid) {
  const h = String(cardUid || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return h.length >= 8 ? h.slice(0, 8) : '';
}

function toHex(s) {
  return Buffer.from(String(s == null ? '' : s), 'utf8').toString('hex').toUpperCase();
}

// Obcina tekst do limitu BAJTÓW (UTF-8), nie rozcinając polskich znaków w połowie.
function truncateUtf8(s, maxBytes) {
  let out = String(s == null ? '' : s);
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1);
  return out;
}

async function queueDeviceCommand(mac, cmd) {
  await dbPool.query('INSERT INTO device_commands (mac_address, cmd) VALUES ($1, $2)', [mac, cmd]);
}

// kind: 'A' (aktywność), 'D' (usunięcie), 'N' (nazwa), 'S' (harmonogram); arg = reszta komendy.
async function queueCardCommand(mac, cardUid, kind, arg) {
  const uid = uidToHex8(cardUid);
  if (!uid) {
    writeToLocalLogFile('User Mutation', `[Node: ${mac}] Pominięto komendę ${kind}: karta bez poprawnego UID (${cardUid}).`);
    return false;
  }
  await queueDeviceCommand(mac, arg === undefined ? `${kind}|${uid}` : `${kind}|${uid}|${arg}`);
  return true;
}

async function pendingCommandCount(mac) {
  const r = await dbPool.query(
    'SELECT COUNT(*) FROM device_commands WHERE mac_address = $1 AND acked_at IS NULL', [mac]);
  return parseInt(r.rows[0].count, 10) || 0;
}

const unlockQueues = {};
// actualLockStates[mac] = { state: boolean, timestamp: number, otaProgress: number }
// `state` is GROUND TRUTH reported by the hardware itself (the "opened" flag sent
// on every /api/hardware/poll request) - it must never be set optimistically from
// the app side, or the app ends up showing "open" before the relay has fired.
const actualLockStates = {};
const learningQueues = {};
// pendingUnlocks[mac] = timestamp of the most recent /api/unlock request that the
// hardware has not yet confirmed. Lets ANY connected client show a "pending"
// state until the lock reports back that it has actually opened.
const pendingUnlocks = {};

// Deregistracja (twarde odłączenie centralki): tylko właściciel, potwierdzane
// kodem z maila. deregisterCodes[mac] = { code, accountId, expiresAt } — kod z maila.
// deregisterQueues[mac] = { until, keyHash } — do kiedy komenderujemy urządzeniu wipe EEPROM
// (factory reset) i blokujemy jego automatyczną ponowną rejestrację w pollu.
const deregisterCodes = {};
const deregisterQueues = {};
// Kody potwierdzające USUNIĘCIE KONTA (RODO art. 17) — w pamięci, ważne 15 min.
// Świadomie nie w bazie: to jednorazowy sekret operacji, która i tak kasuje konto.
const accountDeleteCodes = {};
// provisionSkipLog[mac] = ostatni czas zalogowania POMINIĘTEJ rejestracji (throttle 60s),
// żeby diagnostyka „czemu centralka się nie rejestruje" nie zalała logu przy pollu co 1–8s.
const provisionSkipLog = {};

function _sendJSON(res, statusCode, data, origin) {
  // Only echo the Origin back if it's on the allowlist — never '*' in production
  const corsOrigin = (origin && isOriginAllowed(origin)) ? origin : (DEV_ORIGINS[0]);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    // Basic security headers (subset of helmet for a raw-http server)
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=()',
  });
  res.end(JSON.stringify(data));
}

// ─── JWT helpers ─────────────────────────────────────────────────────────────
// `tv` = accounts.token_version w chwili wydania tokenu. Zmiana lub reset hasła
// podbija token_version, więc WSZYSTKIE wcześniej wydane tokeny przestają działać
// (np. ten na zgubionym telefonie) — bez tego JWT żył 7 dni niezależnie od hasła.
function signToken(accountId, tokenVersion = 0) {
  if (!jwt) return null;
  return jwt.sign({ sub: String(accountId), tv: tokenVersion | 0 }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

/**
 * Verify the Bearer token from the Authorization header.
 * Returns the numeric accountId on success, or null on failure.
 */
async function verifyToken(req) {
  if (!jwt) return null;
  const header = req.headers['authorization'] || '';
  const match  = header.match(/^Bearer\s(.+)$/i);
  if (!match) return null;
  let payload;
  try {
    payload = jwt.verify(match[1], JWT_SECRET, { algorithms: ['HS256'] });
  } catch (_) {
    return null;
  }
  const id = parseInt(payload.sub, 10);
  if (!id) return null;
  try {
    const r = await dbPool.query('SELECT token_version FROM accounts WHERE id = $1', [id]);
    if (r.rows.length === 0) return null;                    // konto usunięte → token martwy
    if ((r.rows[0].token_version || 0) !== (payload.tv || 0)) return null;
    return id;
  } catch (e) {
    // 42703 = brak kolumny (migracja jeszcze nie przeszła) — nie odcinamy wszystkich
    // użytkowników, sprawdzamy tylko, czy konto istnieje. Każdy inny błąd = odmowa.
    if (e && e.code === '42703') {
      writeToLocalLogFile('Core Daemon', '[Auth] Brak kolumny accounts.token_version — sprawdź migracje (README §4.4).');
      const r = await dbPool.query('SELECT 1 FROM accounts WHERE id = $1', [id]).catch(() => ({ rows: [] }));
      return r.rows.length ? id : null;
    }
    return null;
  }
}

/**
 * Drop-in guard for protected routes.
 * Usage inside a route block:
 *   const accountId = await requireAuth(req, res); if (!accountId) return;
 */
async function requireAuth(req, res) {
  const id = await verifyToken(req);
  if (!id) {
    // Use the module-level _sendJSON so we can call this before the scoped
    // sendJSON wrapper is available (shouldn't happen in practice, but safe).
    _sendJSON(res, 401, { auth: false, error: 'Token missing or invalid. Please log in again.' },
              req.headers['origin'] || '');
    return null;
  }
  return id;
}


// DYNAMICZNA FUNKCJA PARSOWANIA I SORTOWANIA WERSJI SEMVER Z PLIKÓW LOKALNYCH
function getLatestFirmwareContext() {
  const updatesDir = '/opt/smartlock-server/updates';
  if (!fs.existsSync(updatesDir)) return { version: '0.0.0', filename: null };

  try {
    const files = fs.readdirSync(updatesDir);
    const binFiles = files.filter(f => f.startsWith('lock_v') && f.endsWith('.bin'));

    if (binFiles.length === 0) return { version: '0.0.0', filename: null };

    // Wyciąganie cyfr wersji niezależnie od tego, czy jest kropka po 'v' czy nie
    const getVerArray = (filename) => {
      const match = filename.match(/lock_v\.?(\d+(?:\.\d+)*)\.bin/);   // lock_v3.1.0.bin (dawny wzorzec łapał tylko 1 znak)
      if (!match) return [0];
      return match[1].split('.').map(Number);
    };

    binFiles.sort((a, b) => {
      const verA = getVerArray(a);
      const verB = getVerArray(b);
      for (let i = 0; i < Math.max(verA.length, verB.length); i++) {
        const numA = verA[i] || 0;
        const numB = verB[i] || 0;
        if (numA !== numB) return numB - numA;
      }
      return 0;
    });

    const latestFile = binFiles[0];
    const match = latestFile.match(/lock_v\.?(\d+(?:\.\d+)*)\.bin/);
    const extractedVersion = match ? match[1] : "0.0.0";
    return { version: extractedVersion, filename: latestFile };
  } catch (e) {
    return { version: '0.0.0', filename: null };
  }
}

// ─── GitHub: odczyt wydania i pobieranie assetów (bin + podpis) ───────────────
function githubRequestOptions(p, accept) {
  return {
    hostname: 'api.github.com', path: p, family: 4, timeout: 15000,
    headers: {
      'User-Agent': 'NodeJS-SmartLock-Server',
      'Authorization': `token ${GITHUB_PAT}`,
      ...(accept ? { 'Accept': accept } : {}),
    },
  };
}

function githubJson(p) {
  return new Promise((resolve, reject) => {
    const r = https.get(githubRequestOptions(p), (gr) => {
      let data = '';
      gr.on('data', (c) => { data += c; if (data.length > 2 * 1024 * 1024) gr.destroy(new Error('response too large')); });
      gr.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (gr.statusCode !== 200) return reject(new Error(j.message || `HTTP ${gr.statusCode}`));
          resolve(j);
        } catch (e) { reject(e); }
      });
      gr.on('error', reject);
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
  });
}

// Pobiera asset wydania do pliku (przez .part + rename, żeby centralka nigdy nie
// dostała połowy pliku). Po przekierowaniu na serwer plików tokenu GitHub NIE
// wysyłamy dalej — należy wyłącznie do api.github.com.
function downloadGithubAsset(assetId, destPath) {
  return new Promise((resolve, reject) => {
    const tmp = destPath + '.part';
    const fail = (e) => { try { fs.unlinkSync(tmp); } catch (_) {} reject(e); };
    const fetchStep = (opts, hops) => {
      const r = https.get(opts, (fr) => {
        if ((fr.statusCode === 301 || fr.statusCode === 302) && fr.headers.location && hops < 5) {
          fr.resume();
          let u;
          try { u = new URL(fr.headers.location); } catch (e) { return fail(e); }
          if (u.protocol !== 'https:') return fail(new Error('redirect to non-https'));
          return fetchStep({ hostname: u.hostname, path: u.pathname + u.search, family: 4, timeout: 30000,
                             headers: { 'User-Agent': 'NodeJS-SmartLock-Server' } }, hops + 1);
        }
        if (fr.statusCode !== 200) { fr.resume(); return fail(new Error(`HTTP ${fr.statusCode}`)); }
        const out = fs.createWriteStream(tmp);
        fr.pipe(out);
        out.on('finish', () => out.close(() => {
          try { fs.renameSync(tmp, destPath); resolve(); } catch (e) { fail(e); }
        }));
        out.on('error', fail);
        fr.on('error', fail);
      });
      r.on('timeout', () => r.destroy(new Error('timeout')));
      r.on('error', fail);
    };
    fetchStep(githubRequestOptions(`/repos/${GITHUB_USER}/${GITHUB_REPO}/releases/assets/${assetId}`, 'application/octet-stream'), 0);
  });
}

// Wipe centralki (deregistracja / usunięcie konta): wiersz urządzenia zaraz zniknie,
// więc hash klucza zapamiętujemy TERAZ — w oknie 120 s poll z komendą wipe odbierze
// tylko prawdziwa centralka, a nie ktoś, kto zna jej MAC.
async function scheduleDeviceWipe(mac) {
  const r = await dbPool.query('SELECT device_key_hash FROM devices WHERE mac_address = $1', [mac]).catch(() => ({ rows: [] }));
  deregisterQueues[mac] = { until: Date.now() + 120 * 1000, keyHash: (r.rows[0] && r.rows[0].device_key_hash) || null };
}

// Rate-limit store for keypad PIN attempts { mac: {count, resetAt} }
const keypadAttempts = {};

// Minimalne escapowanie HTML — treści wstawiane do strony /invite (nazwa
// urządzenia, e-mail) pochodzą od użytkownika, więc nie mogą zepsuć znaczników.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Strona akceptacji zaproszenia współadministratora otwierana z linku w mailu.
// Renderowana po stronie serwera (działa w każdej przeglądarce, bez deep-linku
// do aplikacji). Po utworzeniu konta użytkownik loguje się w aplikacji CTRLABLE.
function renderInvitePage(opts) {
  const { error, token, email, deviceName } = opts || {};
  const head = `<!doctype html><html lang="pl"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>CTRLABLE — Zaproszenie</title>
    <style>
      *{box-sizing:border-box} body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;
        background:#0f172a; color:#e2e8f0; margin:0; min-height:100vh; display:flex;
        align-items:center; justify-content:center; padding:20px}
      .card{background:#1e293b; border-radius:16px; padding:28px; max-width:420px; width:100%;
        box-shadow:0 10px 40px rgba(0,0,0,.4)}
      h1{font-size:20px; margin:0 0 6px} .sub{color:#94a3b8; font-size:14px; margin:0 0 20px}
      label{display:block; font-size:13px; color:#94a3b8; margin:14px 0 6px}
      input{width:100%; padding:12px; border-radius:8px; border:1px solid #334155;
        background:#0f172a; color:#e2e8f0; font-size:15px}
      input[readonly]{opacity:.7}
      .pwwrap{position:relative}
      .pweye{position:absolute; right:12px; top:12px; color:#38bdf8; font-weight:bold; font-size:13px; cursor:pointer; user-select:none}
      a.legal{color:#38bdf8; text-decoration:underline}
      .store{margin-top:20px; padding-top:16px; border-top:1px solid #334155; font-size:12px; color:#64748b; text-align:center}
      .row{display:flex; align-items:flex-start; gap:8px; margin:16px 0; font-size:13px; color:#cbd5e1}
      button{width:100%; margin-top:20px; padding:13px; border:none; border-radius:8px;
        background:#0284c7; color:#fff; font-size:16px; font-weight:bold; cursor:pointer}
      button:disabled{opacity:.5}
      .msg{margin-top:16px; padding:12px; border-radius:8px; font-size:14px; display:none}
      .ok{background:#064e3b; color:#6ee7b7} .err{background:#7f1d1d; color:#fecaca; display:block}
      .dev{color:#38bdf8; font-weight:bold}
    </style></head><body><div class="card">`;
  const foot = `</div></body></html>`;

  if (error) {
    return head + `<h1>Zaproszenie</h1><div class="msg err">${escapeHtml(error)}</div>` + foot;
  }
  return head + `
    <h1>Dołącz do zarządzania centralką</h1>
    <p class="sub">Zostałeś zaproszony jako administrator urządzenia <span class="dev">${escapeHtml(deviceName)}</span>. Utwórz konto, aby uzyskać dostęp.</p>
    <label>Adres e-mail</label>
    <input type="email" value="${escapeHtml(email)}" readonly>
    <label>Ustaw hasło (min. ${MIN_PASSWORD_LENGTH} znaków)</label>
    <div class="pwwrap">
      <input id="pw" type="password" autocomplete="new-password" placeholder="Twoje hasło" style="padding-right:64px">
      <span class="pweye" id="pweye" onclick="togglePw()">Pokaż</span>
    </div>
    <div class="row">
      <input id="rodo" type="checkbox" style="width:auto; margin-top:2px">
      <label for="rodo" style="margin:0">Akceptuję <a class="legal" href="${escapeHtml(PRIVACY_URL)}" target="_blank" rel="noopener">Politykę Prywatności</a> oraz <a class="legal" href="${escapeHtml(TERMS_URL)}" target="_blank" rel="noopener">Regulamin</a> i przetwarzanie moich danych.</label>
    </div>
    <button id="go" onclick="submitAccept()">Utwórz konto i przyjmij zaproszenie</button>
    <div id="msg" class="msg"></div>
    <div class="store">📱 Aplikacja CTRLABLE — wkrótce w App Store i Google Play</div>
    <script>
      var TOKEN=${JSON.stringify(token)};
      function togglePw(){var i=document.getElementById('pw');var e=document.getElementById('pweye');if(i.type==='password'){i.type='text';e.textContent='Ukryj';}else{i.type='password';e.textContent='Pokaż';}}
      function show(cls,text){var m=document.getElementById('msg');m.className='msg '+cls;m.style.display='block';m.textContent=text;}
      async function submitAccept(){
        var pw=document.getElementById('pw').value;
        var rodo=document.getElementById('rodo').checked;
        if(pw.length<${MIN_PASSWORD_LENGTH}){show('err','Hasło musi mieć co najmniej ${MIN_PASSWORD_LENGTH} znaków.');return;}
        if(!rodo){show('err','Zaznacz akceptację polityki prywatności.');return;}
        var btn=document.getElementById('go');btn.disabled=true;
        try{
          var r=await fetch('/api/devices/accept_via_web',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({token:TOKEN,password:pw,privacy_policy_accepted:true})});
          var d=await r.json();
          if(r.ok&&d.status==='ok'){
            show('ok', d.existed
              ? 'Dostęp przyznany! Masz już konto na tym adresie — zaloguj się w aplikacji CTRLABLE swoim dotychczasowym hasłem.'
              : 'Konto utworzone i dostęp przyznany! Zaloguj się teraz w aplikacji CTRLABLE.');
            btn.style.display='none';
          } else { show('err', d.error||'Nie udało się przyjąć zaproszenia.'); btn.disabled=false; }
        }catch(e){ show('err','Błąd połączenia z serwerem.'); btn.disabled=false; }
      }
    </script>` + foot;
}

const server = http.createServer(async (req, res) => {
  const reqOrigin = req.headers['origin'] || '';

  // Scoped wrapper — all route handlers call sendJSON(res,…) unchanged
  // but the current request's origin is automatically forwarded.
  const sendJSON = (r, code, data) => _sendJSON(r, code, data, reqOrigin);

  if (req.method === 'OPTIONS') {
    const corsOrigin = isOriginAllowed(reqOrigin) ? reqOrigin : DEV_ORIGINS[0];
    res.writeHead(204, {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  let rawIp = req.socket.remoteAddress || '';
  let cleanIp = rawIp.includes('::ffff:') ? rawIp.split('::ffff:')[1] : rawIp;
  // Za proxy: prawdziwy adres klienta z X-Real-IP (ustawia NPM). Bez tego wszystkie
  // limity per-IP liczyły się dla JEDNEGO adresu — proxy — wspólnie dla wszystkich.
  // Sprawdzane PRZED mapowaniem localhost niżej, żeby działało też proxy na tym hoście.
  const viaTrustedProxy = TRUSTED_PROXIES.includes(cleanIp);
  if (viaTrustedProxy) {
    const fwd = String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim();
    if (/^[0-9a-fA-F:.]{3,45}$/.test(fwd)) cleanIp = fwd;
  }
  if (!viaTrustedProxy && (cleanIp === '127.0.0.1' || cleanIp === '::1')) cleanIp = '192.168.0.46';

  // Body doklejane kawałkami (wcześniej `bodyStr = chunk` gubiło wszystko poza
  // ostatnim fragmentem) i z twardym limitem — bez niego jedno żądanie mogło
  // zapchać pamięć procesu.
  const MAX_BODY_BYTES = 64 * 1024;
  let bodyStr = '';
  let bodyTooLarge = false;
  req.on('data', chunk => {
    if (bodyTooLarge) return;
    bodyStr += chunk;
    if (bodyStr.length > MAX_BODY_BYTES) { bodyTooLarge = true; bodyStr = ''; }
  });
  req.on('end', async () => {
    if (bodyTooLarge) return sendJSON(res, 413, { error: 'Payload too large' });
    let body = {};
    if (bodyStr) {
      try { body = JSON.parse(bodyStr); } catch (e) { }
    }

    const unparsedRawUrlString = req.url || '';
    const isBackgroundHandshakeNoise =
      /poll/i.test(unparsedRawUrlString) ||
      /data/i.test(unparsedRawUrlString) ||
      /log_button/i.test(unparsedRawUrlString);

    if (!isBackgroundHandshakeNoise) {
      writeToLocalLogFile('Radar Traffic', `Inbound ${req.method} request to path: "${pathname}" from Network IP: ${cleanIp}`);
    }

    try {
      // =========================================================================
      // REJESTRACJA KONTA  EMAIL POWITALNY  AUDYT RODO
      // =========================================================================
      if (pathname === '/api/auth/register' && req.method === 'POST') {
        if (!body.email || !body.password) return sendJSON(res, 400, { error: "Missing identity payloads" });
        if (String(body.password).length < MIN_PASSWORD_LENGTH) {
          return sendJSON(res, 400, { error: `Hasło musi mieć co najmniej ${MIN_PASSWORD_LENGTH} znaków.` });
        }
        const regWait = checkRateLimit(registerAttempts, cleanIp, 10, 60 * 60 * 1000);
        if (regWait > 0) {
          res.setHeader('Retry-After', String(regWait));
          return sendJSON(res, 429, { error: `Zbyt wiele prób rejestracji. Spróbuj ponownie za ${Math.ceil(regWait / 60)} min.` });
        }

        // 🛡️ Strażnik RODO - sprawdzenie akceptacji z aplikacji mobilnej
        if (!body.privacy_policy_accepted) {
          return sendJSON(res, 400, { error: "Rejestracja odrzucona. Wymagany akcept polityki prywatności." });
        }

        const cleanEmail = body.email.trim().toLowerCase();
        const hash = await bcrypt.hash(body.password, 10);
        const acceptedTimestamp = new Date(); // Generowanie czasu TIMESTAMP dla Postgresa

        const verifyCode = genCode6();
        codeReset(`verify:${cleanEmail}`);

        // Wspólny nadawca kodu weryfikacyjnego (używany przy nowej rejestracji ORAZ
        // przy ponownej próbie rejestracji konta jeszcze niezweryfikowanego).
        const sendVerifyCode = (code) => {
          const codeMailManifest = {
            from: '"CTRLABLE Node System" <node@ctrlable.pl>',
            to: cleanEmail,
            subject: 'Twój kod weryfikacyjny CTRLABLE',
            html: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
                <h2>Potwierdź swój adres e-mail</h2>
                <p>Dziękujemy za założenie konta w systemie <strong>CTRLABLE Node</strong>. Aby dokończyć rejestrację, wpisz w aplikacji ten kod:</p>
                <h1 style="color:#0284c7; font-family:monospace; letter-spacing:4px;">${code}</h1>
                <p>Kod jest ważny przez 15 minut. Jeśli to nie Ty zakładałeś konto, zignoruj tę wiadomość.</p>
              </div>`
          };
          mailTransport.sendMail(codeMailManifest, (err, info) => {
            if (err) writeToLocalLogFile('Verify SMTP Fail', err.message);
          });
        };

        try {
          // Konto zakładane jako NIEZWERYFIKOWANE (email_verified=false) + kod ważny 15 min.
          // Aktywacja i e-mail powitalny dopiero po /api/auth/verify_email.
          await dbPool.query(
            `INSERT INTO accounts (email, password_hash, privacy_policy_accepted_at, email_verified, email_verify_code, email_verify_expires)
             VALUES ($1, $2, $3, false, $4, NOW() + INTERVAL '15 minutes')`,
            [cleanEmail, hash, acceptedTimestamp, verifyCode]
          );

          sendVerifyCode(verifyCode);
          writeToLocalLogFile('Authentication Panel', `Rejestracja (oczekuje na weryfikację): ${cleanEmail}. Zgoda RODO: ${acceptedTimestamp}`);
          return sendJSON(res, 200, { status: "code_sent" });

        } catch (err) {
          console.error("Błąd zapisu konta w Postgresie:", err);
          // '23505' = e-mail już istnieje. Jeśli istniejące konto jest jeszcze
          // NIEZWERYFIKOWANE — nie blokujemy w ślepej uliczce: nadpisujemy hasło+zgodę,
          // generujemy nowy kod i wysyłamy ponownie. Jeśli JUŻ zweryfikowane — 400.
          if (err.code === '23505') {
            const existing = await dbPool.query('SELECT email_verified FROM accounts WHERE email = $1', [cleanEmail]);
            if (existing.rows.length > 0 && existing.rows[0].email_verified === false) {
              await dbPool.query(
                `UPDATE accounts
                   SET password_hash = $1, privacy_policy_accepted_at = $2,
                       email_verify_code = $3, email_verify_expires = NOW() + INTERVAL '15 minutes'
                 WHERE email = $4`,
                [hash, acceptedTimestamp, verifyCode, cleanEmail]
              );
              sendVerifyCode(verifyCode);
              writeToLocalLogFile('Authentication Panel', `Ponowna rejestracja niezweryfikowanego konta — nowy kod: ${cleanEmail}`);
              return sendJSON(res, 200, { status: "code_sent" });
            }
            return sendJSON(res, 400, { error: 'Ten adres e-mail jest już zarejestrowany w systemie.' });
          }
          return sendJSON(res, 500, { error: 'Wewnętrzny błąd bazy danych przy rejestracji.' });
        }
      }

      // =========================================================================
      // WERYFIKACJA E-MAIL KODEM 6-CYFROWYM → aktywacja konta + e-mail powitalny + JWT
      // =========================================================================
      if (pathname === '/api/auth/verify_email' && req.method === 'POST') {
        const { email, code } = body || {};
        if (!email || !code) return sendJSON(res, 400, { error: "Brak e-maila lub kodu." });

        const cleanEmail = email.trim().toLowerCase();
        const vWait = checkRateLimit(codeCheckAttempts, cleanIp, 30, 15 * 60 * 1000);
        if (vWait > 0) {
          res.setHeader('Retry-After', String(vWait));
          return sendJSON(res, 429, { error: 'Zbyt wiele prób. Spróbuj ponownie później.' });
        }
        const userRes = await dbPool.query(
          'SELECT id, email_verified, token_version FROM accounts WHERE email = $1 AND email_verify_code = $2 AND email_verify_expires > NOW()',
          [cleanEmail, String(code).trim()]
        );

        if (userRes.rows.length === 0) {
          // Już zweryfikowane? Zwróć spójny sukces, żeby apka nie utknęła.
          const already = await dbPool.query('SELECT id, email_verified FROM accounts WHERE email = $1', [cleanEmail]);
          if (already.rows.length > 0 && already.rows[0].email_verified === true) {
            return sendJSON(res, 200, { status: "already_verified" });
          }
          // Po CODE_MAX_ATTEMPTS pomyłkach kod jest spalony — nowy wysyła ponowna
          // rejestracja albo próba logowania.
          if (already.rows.length > 0 && codeFailed(`verify:${cleanEmail}`)) {
            await dbPool.query('UPDATE accounts SET email_verify_code = NULL WHERE email = $1', [cleanEmail]);
            codeReset(`verify:${cleanEmail}`);
            writeToLocalLogFile('Auth RateLimit', `Kod weryfikacyjny unieważniony po ${CODE_MAX_ATTEMPTS} błędnych próbach: ${cleanEmail}`);
            return sendJSON(res, 429, { error: 'Za dużo błędnych prób — kod unieważniony. Zaloguj się ponownie, aby otrzymać nowy.' });
          }
          return sendJSON(res, 400, { error: "Kod jest nieprawidłowy lub wygasł." });
        }
        codeReset(`verify:${cleanEmail}`);

        // Aktywacja: kasujemy kod, ustawiamy verified.
        await dbPool.query(
          'UPDATE accounts SET email_verified = true, email_verify_code = NULL, email_verify_expires = NULL WHERE id = $1',
          [userRes.rows[0].id]
        );

        const welcomeMailManifest = {
          from: '"CTRLABLE Node System" <node@ctrlable.pl>',
          to: cleanEmail,
          subject: 'Witamy w ekosystemie CTRLABLE!',
          html: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
              <h2>Konto potwierdzone — witaj w CTRLABLE Node!</h2>
              <p>Twój adres e-mail został zweryfikowany, a konto jest aktywne.</p>
              <p><strong>Kolejny krok:</strong> zainicjalizuj centralkę w aplikacji — połącz się z siecią <strong>CTRLABLE_SETUP</strong> i przypisz urządzenie do tego konta.</p>
              <p>Po dodaniu centralki dodasz karty RFID (tryb uczenia) oraz kody PIN.</p>
              <br>
              <p>Pozdrawiamy,<br><strong>Zespół CTRLABLE</strong></p>
            </div>`
        };
        mailTransport.sendMail(welcomeMailManifest, (err, info) => {
          if (err) writeToLocalLogFile('Welcome SMTP Fail', err.message);
        });

        const token = signToken(userRes.rows[0].id, userRes.rows[0].token_version || 0);
        writeToLocalLogFile('Authentication Panel', `Konto zweryfikowane i aktywowane: ${cleanEmail}`);
        return sendJSON(res, 200, { status: "verified", auth: true, token, accountId: userRes.rows[0].id });
      }

      // =========================================================================
      // LOGOWANIE DO APLIKACJI (WERSJA BEZPIECZNA  JWT  RATE LIMIT)
      // =========================================================================
      if (pathname === '/api/auth/login' && req.method === 'POST') {

        // ── Rate limit: max 10 login attempts per IP per 15 minutes ──────────
        const waitSec = checkRateLimit(loginAttempts, cleanIp, 10, 15 * 60 * 1000);
        if (waitSec > 0) {
          writeToLocalLogFile('Auth RateLimit', `Login rate-limited for IP: ${cleanIp}`);
          res.setHeader('Retry-After', String(waitSec));
          return sendJSON(res, 429, { error: `Too many login attempts. Try again in ${waitSec}s.` });
        }

        //Tarcza anty-crash: Jeśli body jest puste lub brakuje pól, kończymy bez wywalenia serwera
        if (!body || !body.email || !body.password) {
          writeToLocalLogFile('Auth Rejection', `Malformed login payload received`);
          return sendJSON(res, 400, { error: "Missing email or password in payload" });
        }

        const cleanEmail = body.email.trim().toLowerCase();
        const result = await dbPool.query('SELECT * FROM accounts WHERE email = $1', [cleanEmail]);

        if (result.rows.length === 0) {
          writeToLocalLogFile('Auth Rejection', `Failed login attempt: ${cleanEmail}`);
          return sendJSON(res, 401, { error: "Invalid credentials" });
        }

        const valid = await bcrypt.compare(body.password, result.rows[0].password_hash);

        if (!valid) {
          writeToLocalLogFile('Auth Rejection', `Failed login: ${cleanEmail} (Password hash mismatch)`);

          if (result.rows[0].push_token && result.rows[0].push_alarms !== false) {
            sendPushNotification(
              result.rows[0].push_token,
              "Próba autoryzacji konta",
              `Zarejestrowano niepoprawną próbę logowania na Twój profil z adresu IP: ${cleanIp}`
            );
          }

          return sendJSON(res, 401, { error: "Invalid credentials" });
        }

        // ── Konto niezweryfikowane: nie wpuszczamy. Wysyłamy świeży kod i kierujemy
        //    apkę do ekranu weryfikacji (status:"unverified" + email). ─────────────
        if (result.rows[0].email_verified === false) {
          const freshCode = genCode6();
          codeReset(`verify:${cleanEmail}`);
          await dbPool.query(
            `UPDATE accounts SET email_verify_code = $1, email_verify_expires = NOW() + INTERVAL '15 minutes' WHERE id = $2`,
            [freshCode, result.rows[0].id]
          );
          mailTransport.sendMail({
            from: '"CTRLABLE Node System" <node@ctrlable.pl>',
            to: cleanEmail,
            subject: 'Twój kod weryfikacyjny CTRLABLE',
            html: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
                <h2>Potwierdź swój adres e-mail</h2>
                <p>Aby zalogować się do CTRLABLE Node, dokończ weryfikację konta tym kodem:</p>
                <h1 style="color:#0284c7; font-family:monospace; letter-spacing:4px;">${freshCode}</h1>
                <p>Kod jest ważny przez 15 minut.</p>
              </div>`
          }, (err) => { if (err) writeToLocalLogFile('Verify SMTP Fail', err.message); });
          writeToLocalLogFile('Auth Rejection', `Login zablokowany — konto niezweryfikowane, wysłano kod: ${cleanEmail}`);
          return sendJSON(res, 403, { error: "Konto niezweryfikowane. Wysłaliśmy nowy kod na Twój e-mail.", status: "unverified", email: cleanEmail });
        }

        // ── Success: issue a signed JWT ───────────────────────────────────────
        const token = signToken(result.rows[0].id, result.rows[0].token_version || 0);
        writeToLocalLogFile('Authentication Panel', `User logged in successfully: ${cleanEmail}`);
        return sendJSON(res, 200, {
          auth: true,
          status: "logged_in",
          token: token,            // ← signed JWT replaces the raw accountId
          // accountId still included for backward-compat with older app builds;
          // new app builds should use only the token.
          accountId: result.rows[0].id
        });
      }

      // =========================================================================
      // KROK 1: ZGŁOSZENIE PROŚBY O RESET (BEZPIECZNY KOD 6-CYFROWY)
      // =========================================================================
      if (pathname === '/api/auth/forgot_password' && req.method === 'POST') {
        // ── Rate limit: max 5 reset requests per IP per 60 minutes ───────────
        const waitSec = checkRateLimit(forgotAttempts, cleanIp, 5, 60 * 60 * 1000);
        if (waitSec > 0) {
          writeToLocalLogFile('Auth RateLimit', `Forgot-password rate-limited for IP: ${cleanIp}`);
          res.setHeader('Retry-After', String(waitSec));
          return sendJSON(res, 429, { error: `Too many reset requests. Try again in ${Math.ceil(waitSec/60)} min.` });
        }

        const cleanEmail = body.email ? body.email.trim().toLowerCase() : '';
        if (!cleanEmail) return sendJSON(res, 400, { error: "Nie podano email" });
        // Limit także per e-mail: nowy kod = kolejne próby, więc bez tego atakujący
        // zmieniający adres IP zamawiałby kody bez końca. Odpowiedź taka sama jak zawsze,
        // żeby nie zdradzać, czy konto istnieje.
        if (checkRateLimit(forgotPerEmail, cleanEmail, 5, 60 * 60 * 1000) > 0) {
          return sendJSON(res, 200, { status: "processed" });
        }

        const checkAccount = await dbPool.query('SELECT id FROM accounts WHERE email = $1', [cleanEmail]);
        if (checkAccount.rows.length === 0) {
          return sendJSON(res, 200, { status: "processed" });
        }

        const secureCode = genCode6();
        codeReset(`reset:${cleanEmail}`);

        await dbPool.query(
          `UPDATE accounts
           SET reset_token = $1, reset_token_expires = NOW() + INTERVAL '15 minutes'
           WHERE email = $2`,
          [secureCode, cleanEmail]
        );

        const automatedMailManifest = {
          from: '"CTRLABLE Node System" <node@ctrlable.pl>',
          to: cleanEmail,
          subject: 'Kod autoryzacyjny resetu hasła CTRLABLE',
          html: `<h3>Twój kod weryfikacyjny:</h3>
                 <h1 style="color:#0284c7; font-family:monospace; letter-spacing:2px;">${secureCode}</h1>
                 <p>Kod jest ważny przez 15 minut. Jeśli nie prosiłeś o reset hasła, możesz zignorować tę wiadomość.</p>`
        };

        mailTransport.sendMail(automatedMailManifest, (mailError, info) => {
          if (mailError) writeToLocalLogFile('Błąd serwera SMTP', mailError.message);
        });

        return sendJSON(res, 200, { status: "processed" });
      }

      // Sprawdzenie kodu resetu — wspólne dla obu kroków. Kod 6-cyfrowy bez limitu prób
      // dało się zgadnąć, a przejęte konto = zdalne otwieranie drzwi. Teraz: limit per IP
      // oraz CODE_MAX_ATTEMPTS pomyłek na jeden kod, po których kod jest unieważniany.
      const checkResetCode = async (email, code) => {
        const cleanEmail = String(email).trim().toLowerCase();
        const wait = checkRateLimit(codeCheckAttempts, cleanIp, 30, 15 * 60 * 1000);
        if (wait > 0) return { status: 429, error: 'Zbyt wiele prób. Spróbuj ponownie później.' };
        const userRes = await dbPool.query(
          'SELECT id FROM accounts WHERE email = $1 AND reset_token = $2 AND reset_token_expires > NOW()',
          [cleanEmail, String(code).trim()]
        );
        if (userRes.rows.length === 0) {
          if (codeFailed(`reset:${cleanEmail}`)) {
            await dbPool.query('UPDATE accounts SET reset_token = NULL, reset_token_expires = NULL WHERE email = $1', [cleanEmail]);
            codeReset(`reset:${cleanEmail}`);
            writeToLocalLogFile('Auth RateLimit', `Kod resetu unieważniony po ${CODE_MAX_ATTEMPTS} błędnych próbach: ${cleanEmail} (IP ${cleanIp})`);
            return { status: 429, error: 'Za dużo błędnych prób — kod unieważniony. Poproś o nowy kod.' };
          }
          return { status: 400, error: 'Kod jest nieprawidłowy lub wygasł' };
        }
        return { status: 200, accountId: userRes.rows[0].id, cleanEmail };
      };

      if (pathname === '/api/auth/verify_reset_code' && req.method === 'POST') {
        const { email, code } = body;
        if (!email || !code) return sendJSON(res, 400, { error: "Missing parameters" });
        const chk = await checkResetCode(email, code);
        if (chk.status !== 200) return sendJSON(res, chk.status, { error: chk.error });
        return sendJSON(res, 200, { valid: true });
      }

      if (pathname === '/api/auth/confirm_password_reset' && req.method === 'POST') {
        const { email, code, newPassword } = body;
        if (!email || !code || !newPassword) return sendJSON(res, 400, { error: "Missing parameters" });
        if (String(newPassword).length < MIN_PASSWORD_LENGTH) {
          return sendJSON(res, 400, { error: `Hasło musi mieć co najmniej ${MIN_PASSWORD_LENGTH} znaków.` });
        }
        const chk = await checkResetCode(email, code);
        if (chk.status !== 200) return sendJSON(res, chk.status, { error: chk.error });

        // token_version + 1 → wylogowanie ze wszystkich urządzeń (reset hasła zwykle
        // oznacza, że ktoś inny mógł je znać).
        const hash = await bcrypt.hash(String(newPassword), 10);
        await dbPool.query(
          `UPDATE accounts SET password_hash = $1, reset_token = null, reset_token_expires = null,
                  token_version = COALESCE(token_version, 0) + 1 WHERE id = $2`,
          [hash, chk.accountId]
        );
        codeReset(`reset:${chk.cleanEmail}`);

        writeToLocalLogFile('Reset System', `Hasło zostało pomyślnie zmienione dla: ${chk.cleanEmail} (sesje unieważnione)`);
        return sendJSON(res, 200, { success: true });
      }

      // =========================================================================
      // DOSTARCZANIE DANYCH DO APLIKACJI MOBILNEJ
      // =========================================================================
      if (pathname === '/api/data' && req.method === 'GET') {
        const accountId = await requireAuth(req, res); if (!accountId) return;

        const accountsRes = await dbPool.query('SELECT email, push_entries, push_alarms FROM accounts WHERE id = $1', [accountId]);
        if (accountsRes.rows.length === 0) return sendJSON(res, 404, { error: "Account invalid" });

        // serviceEmail: klient musi znać adres serwisu, żeby go zaprosić (przycisk w „Zespole").
        const appAccountContext = { email: accountsRes.rows[0].email, isServiceAccount: isServiceEmail(accountsRes.rows[0].email),
                                    serviceEmail: Array.from(SERVICE_ACCOUNTS)[0] || null, serviceShareHours: SERVICE_SHARE_HOURS };

        // Widoczne są zarówno urządzenia własne, jak i te udostępnione przez
        // innego właściciela (wielu administratorów na jeden zamek).
        const devicesRes = await dbPool.query(
          `SELECT d.*, (d.account_id = $1) AS is_owner
           FROM devices d
           WHERE d.account_id = $1 OR d.mac_address IN (SELECT mac_address FROM device_shares WHERE account_id = $1 AND ${SHARE_ACTIVE})
           ORDER BY d.mac_address ASC`, [accountId]);
        if (devicesRes.rows.length === 0) {
          return sendJSON(res, 200, { auth: true, account: appAccountContext, mode: 'Czuwanie', lock: false, total: 0, users: [], logs: [], devices: [] });
        }

        // Lista urządzeń dla przełącznika w aplikacji (multi-device).
        const deviceList = devicesRes.rows.map(d => ({
          mac: d.mac_address,
          name: d.device_name || d.mac_address,
          mode: d.operational_mode,
          firmwareVersion: d.firmware_version,
          isOwner: d.is_owner,
          // Czas otwarcia rygla per centralka — moduł „Centralki" pokazuje i ustawia
          // to dla KAŻDEJ z nich, nie tylko dla aktywnie wybranej.
          autoLockSeconds: Math.round((d.auto_lock_delay_ms || 3000) / 1000),
        }));

        // Wybór aktywnego urządzenia: ?mac= z zapytania, jeśli należy do
        // konta, w przeciwnym razie pierwsze urządzenie (stare zachowanie).
        const requestedMac = (query.mac || '').toUpperCase();
        const primaryDevice = devicesRes.rows.find(d => d.mac_address === requestedMac) || devicesRes.rows[0];
        const primaryMac = primaryDevice.mac_address;

        const usersRes = await dbPool.query(
          `SELECT id, holder_name as name, is_active as active, hardware_slot_idx,
                  schedule_enabled, schedule_days, schedule_start_minutes, schedule_end_minutes,
                  is_owner_card, license_locked, keep_on_downgrade
           FROM card_credentials WHERE mac_address = $1 ORDER BY id ASC`, [primaryMac]);
        const logsRes = await dbPool.query('SELECT event_time, message FROM system_events WHERE mac_address = $1 ORDER BY event_time DESC LIMIT 30', [primaryMac]);
        const kpPinsRes = await dbPool.query(
          `SELECT id, name, active, schedule_enabled, schedule_days, schedule_start_minutes,
                  schedule_end_minutes, expires_at, max_uses, use_count, is_guest_code
           FROM keypad_pins WHERE mac_address = $1 ORDER BY created_at ASC`, [primaryMac]
        ).catch(() => ({ rows: [] }));

        const processedUsersList = usersRes.rows.map(row => ({
          id: row.id,                   // STABILNA tożsamość (klucz listy + mutacje)
          idx: row.hardware_slot_idx,   // slot sprzętowy — tylko do synchronizacji z centralką
          name: row.name,
          active: row.active,
          // UID karty celowo NIE trafia do aplikacji: przy kartach dopasowywanych po UID
          // jego znajomość wystarcza do zrobienia duplikatu (README §7.6).
          schedule_enabled: row.schedule_enabled,
          schedule_days: row.schedule_days,
          schedule_start_minutes: row.schedule_start_minutes,
          schedule_end_minutes: row.schedule_end_minutes,
          is_owner_card: !!row.is_owner_card,     // gwiazdka w UI, chroniona przed limitem
          license_locked: !!row.license_locked,   // wyłączona przez pakiet, nie przez człowieka
          keep_on_downgrade: !!row.keep_on_downgrade,  // wskazana przez klienta „ma zostać"
        }));

        const localizedLogsFeed = logsRes.rows.map(r => {
          const timestamp = new Date(r.event_time).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          return `[${timestamp}] ${r.message}`;
        });
        const lastState = actualLockStates[primaryMac];
        const isOffline = !lastState || (Date.now() - lastState.timestamp) > 10000;

        // Stan rygla widziany przez aplikację - ZAWSZE pochodzi z faktycznego
        // zgłoszenia sprzętu (lastState.state), nigdy nie jest zgadywany.
        // Jeśli komenda /api/unlock czeka jeszcze na potwierdzenie ze sprzętu,
        // pokazujemy 'pending', żeby UI nie skakało od razu do "zamknięte".
        let lockValue = 'offline';
        if (!isOffline) {
          if (lastState.state === true) {
            lockValue = true;
          } else {
            const pendingSince = pendingUnlocks[primaryMac];
            // Okno "pending" wydłużone (6s→12s) pod latencję TLS na ESP32: komenda
            // czeka na kolejny poll, a potwierdzenie "opened" wraca po handshake'u —
            // krótsze okno powodowało chwilowy powrót UI na "Zabezpieczony" zanim
            // sprzęt potwierdził otwarcie.
            const stillPending = pendingSince && (Date.now() - pendingSince) < 12000;
            lockValue = stillPending ? 'pending' : false;
          }
        }

        // Uprawnienia pakietu dołączone do KAŻDEJ odpowiedzi /api/data. Dzięki temu
        // ekrany kart/PIN-ów mogą wyszarzyć niedostępne funkcje ZAWCZASU, zamiast
        // pozwalać klientowi kliknąć i dopiero wtedy pokazywać błąd 403. Właściciel
        // urządzenia wyznacza limity — współadmin widzi limity centralki, na której działa.
        const dataEnt = await deviceOwnerEntitlements(primaryMac).catch(() => null);

        //DANE Z BAZY W POSTACI JSON
        return sendJSON(res, 200, {
          auth: true,
          account: appAccountContext,
          entitlements: dataEnt ? {
            tier: dataEnt.license_tier,
            maxCards: dataEnt.max_cards,
            maxPins: dataEnt.max_pins,
            maxAdmins: dataEnt.max_admins,
            maxDevices: dataEnt.max_devices,
            guestCodes: !!dataEnt.guest_codes_enabled,
            pinChangesPerMonth: dataEnt.pin_changes_per_month,
            validUntil: dataEnt.license_valid_until || null,
            // Ile dni do wygaśnięcia (null = bezterminowa). Aplikacja na tej podstawie
            // pokazuje monit „licencja się kończy — wymagana decyzja”.
            daysToExpiry: dataEnt.license_valid_until
              ? Math.ceil((new Date(dataEnt.license_valid_until) - Date.now()) / 86400000)
              : null,
            // Limity pakietu DARMOWEGO — do czego spadnie konto po wygaśnięciu.
            freeMaxCards: TIER_PRESETS.free.max_cards,
            freeMaxPins: TIER_PRESETS.free.max_pins,
          } : null,
          mode: isOffline ? 'Offline' : primaryDevice.operational_mode,
          lock: lockValue,
          total: processedUsersList.length,
          users: processedUsersList,
          logs: localizedLogsFeed,
          version: primaryDevice.firmware_version || latestFirmwareVersion,
          otaPending: !!otaPendingDevices[primaryMac],
          // Zmiany kart/Wi-Fi czekające na odebranie przez centralkę. Aplikacja pokazuje
          // ostrzeżenie, dopóki > 0 — zablokowana karta NIE jest zablokowana na drzwiach,
          // zanim centralka nie potwierdzi komendy.
          pendingCommands: await pendingCommandCount(primaryMac).catch(() => 0),
          pushEntries: accountsRes.rows[0].push_entries !== false,
          pushAlarms: accountsRes.rows[0].push_alarms !== false,
          otaProgress: (actualLockStates[primaryMac]?.otaProgress || 0),
          deviceReleaseId: (actualLockStates[primaryMac]?.deviceReleaseId || 0),
          latestReleaseId: latestFirmwareReleaseId,
          autoLockSeconds: Math.round((primaryDevice.auto_lock_delay_ms || 3000) / 1000),
          isOwner: !!primaryDevice.is_owner,   // wyliczane w SELECT (d.account_id = $1)
          // Stan sesji serwisowej tego konta na aktywnej centralce (tylko konto serwisowe).
          serviceSession: (() => {
            const s = serviceSessions[primaryMac];
            if (!s || s.accountId !== accountId) return null;
            if (Date.now() < s.confirmedUntil) return { state: 'confirmed', until: new Date(s.confirmedUntil).toISOString() };
            if (Date.now() < s.codeUntil) return { state: 'awaiting_code', until: new Date(s.codeUntil).toISOString() };
            return null;
          })(),
          keypad_pins: kpPinsRes.rows,
          devices: deviceList,
          activeMac: primaryMac,
        });
      }

      // =========================================================================
      // ZMIANA NAZWY LOKATORA
      // =========================================================================
      if (pathname === '/api/user/rename' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const { name, mac: reqMac } = body;
        const dev = await resolveTargetDevice(accountId, reqMac);
        if (dev.rows.length === 0) return sendJSON(res, 404, { error: "Hardware missing mapping" });

        const targetMac = dev.rows[0].mac_address;
        const cleanName = String(name || '').trim().slice(0, 64);
        if (!cleanName) return sendJSON(res, 400, { error: "Podaj nazwę" });

        const card = await resolveCardRow(targetMac, body);
        if (!card) return sendJSON(res, 400, { error: "Nie znaleziono karty" });

        await dbPool.query('UPDATE card_credentials SET holder_name = $1 WHERE id = $2', [cleanName, card.id]);
        writeToLocalLogFile('User Mutation', `Renamed card profile row ID: ${card.id}`);

        // Centralka trzyma nazwę w 16-bajtowym polu — obcinamy po bajtach UTF-8.
        const queued = await queueCardCommand(targetMac, card.card_uid, 'N', toHex(truncateUtf8(cleanName, 15)));
        return sendJSON(res, 200, { status: "ok", queued });
      }

      // =========================================================================
      // WYBÓR POŚWIADCZEŃ NA WYPADEK ZEJŚCIA Z PAKIETU — POST { mac, cardIds[], pinIds[] }
      // Mechanizm GŁÓWNY: klient decyduje, co ma dalej działać, zanim licencja wygaśnie.
      // Zapisujemy pełną listę (nie pojedyncze przełączenia), żeby stan w aplikacji
      // i w bazie nie mógł się rozjechać przy równoległych zmianach.
      // =========================================================================
      if (pathname === '/api/license/keep_selection' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const targetMac = String(body.mac || '').toUpperCase();
        // AKTUALIZACJA CZĘŚCIOWA: brak pola = „nie ruszaj tej kategorii”. Bez tego
        // aplikacja wysyłająca tylko karty kasowałaby wybór PIN-ów (nie zna go, bo
        // /api/data nie zwraca ich flag).
        const cardIds = Array.isArray(body.cardIds) ? body.cardIds.map(n => parseInt(n, 10)).filter(Number.isFinite) : null;
        const pinIds  = Array.isArray(body.pinIds)  ? body.pinIds.map(n => parseInt(n, 10)).filter(Number.isFinite)  : null;
        if (!targetMac) return sendJSON(res, 400, { error: 'Brak mac.' });

        const owned = await dbPool.query(
          'SELECT 1 FROM devices WHERE mac_address = $1 AND account_id = $2', [targetMac, accountId]);
        if (owned.rows.length === 0)
          return sendJSON(res, 403, { error: 'Tylko właściciel centralki może wybrać poświadczenia.' });

        // Limit docelowy = pakiet DARMOWY (tam trafia konto po wygaśnięciu).
        const FREE = TIER_PRESETS.free;
        if (cardIds && cardIds.length > FREE.max_cards)
          return sendJSON(res, 400, { error: `Możesz zachować maksymalnie ${FREE.max_cards} kart(y).`, limit: FREE.max_cards });
        if (pinIds && pinIds.length > FREE.max_pins)
          return sendJSON(res, 400, { error: `Możesz zachować maksymalnie ${FREE.max_pins} PIN-ów.`, limit: FREE.max_pins });

        if (cardIds) {
          await dbPool.query('UPDATE card_credentials SET keep_on_downgrade = false WHERE mac_address = $1', [targetMac]);
          if (cardIds.length)
            await dbPool.query('UPDATE card_credentials SET keep_on_downgrade = true WHERE mac_address = $1 AND id = ANY($2)', [targetMac, cardIds]);
        }
        if (pinIds) {
          await dbPool.query('UPDATE keypad_pins SET keep_on_downgrade = false WHERE mac_address = $1', [targetMac]);
          if (pinIds.length)
            await dbPool.query('UPDATE keypad_pins SET keep_on_downgrade = true WHERE mac_address = $1 AND id = ANY($2)', [targetMac, pinIds]);
        }

        writeToLocalLogFile('License', `[Node: ${targetMac}] Wybór na wypadek zejścia z pakietu: karty=${cardIds ? cardIds.length : 'bez zmian'}, PIN-y=${pinIds ? pinIds.length : 'bez zmian'}.`);
        // Jeśli licencja JUŻ wygasła, wybór stosujemy natychmiast.
        await enforceLicenseLimits(accountId);
        return sendJSON(res, 200, { status: 'ok', cards: cardIds ? cardIds.length : null, pins: pinIds ? pinIds.length : null });
      }

      // =========================================================================
      // OZNACZENIE KARTY/PIN-u WŁAŚCICIELA — POST { id, mac, type: 'card'|'pin' }
      // Tylko właściciel centralki. Taka karta NIGDY nie jest automatycznie wyłączana
      // przy spadku pakietu (patrz enforceLicenseLimits) — chroni przed sytuacją,
      // w której właściciel zostaje zamknięty przed własnym budynkiem.
      // Jedna karta i jeden PIN na centralkę; ustawienie nowej zdejmuje flagę z poprzedniej.
      // =========================================================================
      if (pathname === '/api/user/set_owner_card' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const { id, mac, type } = body;
        const targetMac = String(mac || '').toUpperCase();
        if (!id || !targetMac) return sendJSON(res, 400, { error: 'Brak id lub mac.' });

        const owned = await dbPool.query(
          'SELECT 1 FROM devices WHERE mac_address = $1 AND account_id = $2', [targetMac, accountId]);
        if (owned.rows.length === 0)
          return sendJSON(res, 403, { error: 'Tylko właściciel centralki może oznaczyć swoją kartę.' });

        if (type === 'pin') {
          await dbPool.query('UPDATE keypad_pins SET is_owner_pin = false WHERE mac_address = $1', [targetMac]);
          await dbPool.query('UPDATE keypad_pins SET is_owner_pin = true WHERE id = $1 AND mac_address = $2', [id, targetMac]);
        } else {
          await dbPool.query('UPDATE card_credentials SET is_owner_card = false WHERE mac_address = $1', [targetMac]);
          await dbPool.query('UPDATE card_credentials SET is_owner_card = true WHERE id = $1 AND mac_address = $2', [id, targetMac]);
        }
        writeToLocalLogFile('User Mutation', `[Node: ${targetMac}] Oznaczono ${type === 'pin' ? 'PIN' : 'kartę'} id=${id} jako należącą do właściciela.`);
        // Zmiana priorytetu może odblokować/zablokować inne poświadczenia.
        await enforceLicenseLimits(accountId);
        return sendJSON(res, 200, { status: 'ok' });
      }

      // =========================================================================
      // AKTUALIZACJA HARMONOGRAMU KARTY RFID (dni + okno godzinowe)
      // POST { idx, mac, scheduleEnabled, scheduleDays, scheduleStartMinutes, scheduleEndMinutes }
      // =========================================================================
      if (pathname === '/api/user/update_schedule' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const { idx, mac: reqMac, scheduleEnabled, scheduleDays, scheduleStartMinutes, scheduleEndMinutes } = body;
        const dev = await resolveTargetDevice(accountId, reqMac);
        if (dev.rows.length === 0) return sendJSON(res, 404, { error: "Hardware missing mapping" });
        const targetMac = dev.rows[0].mac_address;

        const card = await resolveCardRow(targetMac, body);
        if (!card) return sendJSON(res, 400, { error: "Nie znaleziono karty" });

        await dbPool.query(
          `UPDATE card_credentials SET
             schedule_enabled = COALESCE($1, schedule_enabled),
             schedule_days = COALESCE($2, schedule_days),
             schedule_start_minutes = COALESCE($3, schedule_start_minutes),
             schedule_end_minutes = COALESCE($4, schedule_end_minutes)
           WHERE id = $5`,
          [scheduleEnabled, scheduleDays, scheduleStartMinutes, scheduleEndMinutes, card.id]
        );
        writeToLocalLogFile('User Mutation', `[Node: ${targetMac}] Schedule updated for card id=${card.id}`);

        // Egzekwowanie harmonogramu jest LOKALNE (README §5.7), więc dane muszą trafić
        // na urządzenie — kolejką komend, stan po zapisie (nie wartości z żądania).
        const sch = (await dbPool.query(
          `SELECT schedule_enabled, schedule_days, schedule_start_minutes, schedule_end_minutes
             FROM card_credentials WHERE id = $1`, [card.id])).rows[0] || {};
        const clampInt = (v, lo, hi, dflt) => {
          const n = parseInt(v, 10);
          return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
        };
        const queued = await queueCardCommand(targetMac, card.card_uid, 'S',
          `${sch.schedule_enabled ? 1 : 0}|${clampInt(sch.schedule_days, 0, 127, 127)}|` +
          `${clampInt(sch.schedule_start_minutes, 0, 1440, 0)}|${clampInt(sch.schedule_end_minutes, 0, 1440, 1440)}`);
        return sendJSON(res, 200, { success: true, queued });
      }

      // =========================================================================
      // BLOKOWANIE / AKTYWACJA KARTY
      // =========================================================================
      if (pathname === '/api/user/toggle_active' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const { idx, mac: reqMac } = body;
        const dev = await resolveTargetDevice(accountId, reqMac);
        if (dev.rows.length === 0) return sendJSON(res, 404, { error: "Hardware missing mapping" });

        const targetMac = dev.rows[0].mac_address;

        const card = await resolveCardRow(targetMac, body);
        if (!card) return sendJSON(res, 400, { error: "Nie znaleziono karty" });

        const flippedStateBit = !card.is_active;
        await dbPool.query('UPDATE card_credentials SET is_active = $1 WHERE id = $2', [flippedStateBit, card.id]);
        writeToLocalLogFile('User Mutation', `Toggled access bit flag for ID: ${card.id}`);

        // Komenda niesie STAN DOCELOWY (a nie „przełącz") — powtórne doręczenie nie
        // odwróci blokady z powrotem.
        const queued = await queueCardCommand(targetMac, card.card_uid, 'A', flippedStateBit ? '1' : '0');
        return sendJSON(res, 200, { status: "ok", queued });
      }

      // =========================================================================
      // USUNIĘCIE UŻYTKOWNIKA
      // =========================================================================
      if (pathname === '/api/user/delete' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const { idx, mac: reqMac } = body;
        const dev = await resolveTargetDevice(accountId, reqMac);
        if (dev.rows.length === 0) return sendJSON(res, 404, { error: "Hardware missing mapping" });

        const targetMac = dev.rows[0].mac_address;

        const card = await resolveCardRow(targetMac, body);
        if (!card) return sendJSON(res, 400, { error: "Nie znaleziono karty" });

        // Komendę kolejkujemy PRZED usunięciem wiersza (potrzebny UID karty).
        const queued = await queueCardCommand(targetMac, card.card_uid, 'D');
        await dbPool.query('DELETE FROM card_credentials WHERE id = $1', [card.id]);
        writeToLocalLogFile('User Mutation', `Purged key ID context entry: ${card.id}`);
        return sendJSON(res, 200, { status: "ok", queued });
      }

      // =========================================================================
      // ZMIANA HASŁA UŻYTKOWNIKA W USTAWIENIACH
      // =========================================================================
      if (pathname === '/api/settings/password' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const { currentPassword, newPassword } = body;
        if (!newPassword || String(newPassword).length < MIN_PASSWORD_LENGTH) {
          return sendJSON(res, 400, { error: `Nowe hasło musi mieć co najmniej ${MIN_PASSWORD_LENGTH} znaków.` });
        }
        // Obecne hasło jest wymagane: sam token (np. z odblokowanego na chwilę telefonu)
        // nie może wystarczyć do przejęcia konta i wycięcia właściciela.
        if (!currentPassword) return sendJSON(res, 400, { error: 'Podaj obecne hasło.' });
        const pwWait = checkRateLimit(loginAttempts, `pw:${accountId}`, 10, 15 * 60 * 1000);
        if (pwWait > 0) return sendJSON(res, 429, { error: 'Zbyt wiele prób. Spróbuj ponownie później.' });
        const acc = await dbPool.query('SELECT password_hash FROM accounts WHERE id = $1', [accountId]);
        if (acc.rows.length === 0 || !(await bcrypt.compare(String(currentPassword), acc.rows[0].password_hash))) {
          writeToLocalLogFile('Auth Rejection', `Zmiana hasła odrzucona — błędne obecne hasło (konto ${accountId}, IP ${cleanIp}).`);
          return sendJSON(res, 403, { error: 'Obecne hasło jest nieprawidłowe.' });
        }

        // token_version + 1 → pozostałe sesje (inne telefony) zostają wylogowane;
        // bieżący klient dostaje nowy token w odpowiedzi.
        const newAccountHash = await bcrypt.hash(String(newPassword), 10);
        const upd = await dbPool.query(
          `UPDATE accounts SET password_hash = $1, token_version = COALESCE(token_version, 0) + 1
            WHERE id = $2 RETURNING token_version`, [newAccountHash, accountId]);
        writeToLocalLogFile('Settings Update', `Użytkownik ID: ${accountId} zmienił hasło (pozostałe sesje unieważnione).`);
        return sendJSON(res, 200, { success: true, token: signToken(accountId, upd.rows[0].token_version) });
      }

      // =========================================================================
      // ZMIANA PROFILU WI-FI ZAMKA
      // =========================================================================
      if (pathname === '/api/settings/wifi' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const { wifiSSID, wifiPass, mac: reqMac } = body;
        const ssidStr = String(wifiSSID || '');
        const passStr = String(wifiPass || '');
        if (!ssidStr) return sendJSON(res, 400, { error: "SSID cannot be blank" });
        // Firmware trzyma SSID i hasło w polach po 32 bajty (31 znaków + zero).
        if (Buffer.byteLength(ssidStr, 'utf8') > 31 || Buffer.byteLength(passStr, 'utf8') > 31) {
          return sendJSON(res, 400, { error: 'Nazwa sieci i hasło Wi-Fi mogą mieć maks. 31 znaków.' });
        }

        // TYLKO WŁAŚCICIEL (README §6.4) — wcześniej resolveTargetDevice wpuszczał też
        // współadminów, którzy mogli w ten sposób odciąć centralkę od sieci.
        const owned = await dbPool.query(
          reqMac
            ? 'SELECT mac_address FROM devices WHERE account_id = $1 AND mac_address = $2'
            : 'SELECT mac_address FROM devices WHERE account_id = $1 ORDER BY mac_address ASC LIMIT 1',
          reqMac ? [accountId, String(reqMac).toUpperCase()] : [accountId]);
        if (owned.rows.length === 0) return sendJSON(res, 403, { error: 'Tylko właściciel może zmienić sieć Wi-Fi centralki.' });

        const targetMac = owned.rows[0].mac_address;
        await queueDeviceCommand(targetMac, `W|${toHex(ssidStr)}|${toHex(passStr)}`);
        writeToLocalLogFile('Settings Update', `[Node: ${targetMac}] Nowa konfiguracja Wi-Fi zakolejkowana przez właściciela ${accountId}.`);
        return sendJSON(res, 200, { status: "ok", queued: true });
      }

      // =========================================================================
      // ZDALNE WYWOŁANIE OTWARCIA Z APLIKACJI
      // =========================================================================
      // =========================================================================
      // LISTA URZĄDZEŃ NA KONCIE (multi-device)
      // =========================================================================
      // =========================================================================
      // WYSZUKIWANIE/FILTROWANIE LOGÓW — GET z parametrami:
      //   mac      — konkretne urządzenie (opcjonalnie, domyślnie wszystkie widoczne dla konta)
      //   category — entries | security | connections | provisioning | updates | mail
      //   q        — szukany tekst (dopasowanie częściowe, bez uwzględniania wielkości liter)
      //   from, to — zakres dat w formacie ISO (np. 2026-07-01)
      //   limit, offset — paginacja (domyślnie 50 / 0, max limit 200)
      // Widzi tylko zdarzenia z urządzeń, do których konto ma dostęp (właściciel LUB współadmin).
      // =========================================================================
      if (pathname === '/api/logs/search' && req.method === 'GET') {
        const accountId = await requireAuth(req, res); if (!accountId) return;

        const params = [accountId];
        let where = `mac_address IN (
          SELECT mac_address FROM devices WHERE account_id = $1
          UNION
          SELECT mac_address FROM device_shares WHERE account_id = $1 AND ${SHARE_ACTIVE}
        )`;

        if (query.mac) {
          params.push(query.mac.toUpperCase());
          where += ` AND mac_address = $${params.length}`;
        }
        if (query.category) {
          params.push(query.category);
          where += ` AND category = $${params.length}`;
        }
        if (query.q) {
          params.push(`%${query.q}%`);
          where += ` AND message ILIKE $${params.length}`;
        }
        if (query.from) {
          params.push(query.from);
          where += ` AND event_time >= $${params.length}`;
        }
        if (query.to) {
          params.push(query.to);
          where += ` AND event_time <= $${params.length}::date + INTERVAL '1 day'`;
        }

        const limit = Math.min(parseInt(query.limit) || 50, 200);
        const offset = parseInt(query.offset) || 0;
        params.push(limit, offset);

        const rows = await dbPool.query(
          `SELECT mac_address, event_time, message, category FROM system_events
           WHERE ${where}
           ORDER BY event_time DESC
           LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params
        );

        const countRes = await dbPool.query(
          `SELECT COUNT(*) FROM system_events WHERE ${where}`,
          params.slice(0, -2)
        );

        return sendJSON(res, 200, {
          logs: rows.rows.map(r => ({
            mac: r.mac_address,
            time: r.event_time,
            message: r.message,
            category: r.category || 'inne',
          })),
          total: parseInt(countRes.rows[0].count),
          limit, offset,
        });
      }

      if (pathname === '/api/devices/list' && req.method === 'GET') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const devicesRes = await dbPool.query(
          `SELECT mac_address, device_name, operational_mode, firmware_version, last_heartbeat, (account_id = $1) AS is_owner
           FROM devices
           WHERE account_id = $1 OR mac_address IN (SELECT mac_address FROM device_shares WHERE account_id = $1 AND ${SHARE_ACTIVE})
           ORDER BY mac_address ASC`, [accountId]);
        const devices = devicesRes.rows.map(d => ({
          mac: d.mac_address,
          name: d.device_name || d.mac_address,
          mode: d.operational_mode,
          firmwareVersion: d.firmware_version,
          online: d.last_heartbeat && (Date.now() - new Date(d.last_heartbeat).getTime()) < 35000,
          isOwner: d.is_owner,
        }));
        return sendJSON(res, 200, { devices });
      }

      // =========================================================================
      // LICENCJA + ZUŻYCIE — pakiet konta i "ile z ilu" na każdej centralce.
      // Aplikacja pokazuje to na ekranie "Pakiet" i przy dodawaniu kart/PIN-ów.
      // =========================================================================
      if (pathname === '/api/license' && req.method === 'GET') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const ent = await getEntitlements(accountId);
        // Zużycie liczymy dla centralek, których to konto jest WŁAŚCICIELEM
        // (bo licencja jest właściciela). Współadmin widzi limity właściciela.
        const owned = await dbPool.query(
          'SELECT mac_address, device_name FROM devices WHERE account_id = $1 ORDER BY mac_address ASC', [accountId]);
        const usage = [];
        for (const d of owned.rows) {
          const cc = await dbPool.query('SELECT COUNT(*) FROM card_credentials WHERE mac_address = $1', [d.mac_address]);
          const pc = await dbPool.query('SELECT COUNT(*) FROM keypad_pins WHERE mac_address = $1', [d.mac_address]);
          const ac = await dbPool.query(`SELECT COUNT(*) FROM device_shares WHERE mac_address = $1 AND is_service = false AND ${SHARE_ACTIVE}`, [d.mac_address]);
          usage.push({
            mac: d.mac_address,
            name: d.device_name || d.mac_address,
            cards: parseInt(cc.rows[0].count), maxCards: ent.max_cards,
            pins: parseInt(pc.rows[0].count),  maxPins: ent.max_pins,
            admins: parseInt(ac.rows[0].count) + 1, maxAdmins: ent.max_admins, // +1 = właściciel
          });
        }
        return sendJSON(res, 200, {
          tier: ent.license_tier,
          limits: {
            maxCards: ent.max_cards, maxPins: ent.max_pins, maxAdmins: ent.max_admins,
            maxDevices: ent.max_devices, logRetentionDays: ent.log_retention_days,
            guestCodes: ent.guest_codes_enabled, pinChangesPerMonth: ent.pin_changes_per_month,
          },
          validUntil: ent.license_valid_until,
          expired: !!ent.expired,
          devicesUsed: owned.rows.length, maxDevices: ent.max_devices,
          usage,
        });
      }

      // =========================================================================
      // AKTYWACJA KODU LICENCYJNEGO — krótki kod z tabeli license_codes ustawia
      // tier konta. Jednorazowy: atomowe UPDATE ... WHERE used_by IS NULL blokuje
      // podwójne użycie i wyścig. Kod normalizujemy (wielkie litery, bez spacji).
      // =========================================================================
      if (pathname === '/api/license/redeem' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        // Normalizacja: wielkie litery, usuwamy wszystko poza [A-Z0-9] (myślniki,
        // spacje) — klient może wpisać z myślnikami albo bez.
        const code = String((body.key || body.code || '')).toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!code) return sendJSON(res, 400, { error: 'Podaj kod licencyjny.' });
        // Atomowe "zajęcie" kodu — udaje się tylko, gdy istnieje i jest niewykorzystany.
        const claim = await dbPool.query(
          `UPDATE license_codes SET used_by = $1, used_at = NOW()
             WHERE code = $2 AND used_by IS NULL RETURNING tier, days`, [accountId, code]);
        if (claim.rows.length === 0) {
          const exists = await dbPool.query('SELECT 1 FROM license_codes WHERE code = $1', [code]);
          return sendJSON(res, exists.rows.length ? 409 : 400,
            { error: exists.rows.length ? 'Ten kod został już wykorzystany.' : 'Nieprawidłowy kod licencyjny.' });
        }
        const tier = claim.rows[0].tier;
        const days = parseInt(claim.rows[0].days || 0, 10) || 0;   // 0 = bezterminowo
        if (!TIER_PRESETS[tier]) return sendJSON(res, 400, { error: 'Nieznany pakiet w kodzie.' });
        const p = TIER_PRESETS[tier];
        await dbPool.query(
          `UPDATE accounts SET license_tier=$1, max_cards=$2, max_pins=$3, max_admins=$4, max_devices=$5,
                 log_retention_days=$6, guest_codes_enabled=$7, pin_changes_per_month=$8,
                 license_valid_until = CASE WHEN $9::int > 0 THEN NOW() + ($9::int * INTERVAL '1 day') ELSE NULL END
             WHERE id=$10`,
          [tier, p.max_cards, p.max_pins, p.max_admins, p.max_devices,
           p.log_retention_days, p.guest_codes_enabled, p.pin_changes_per_month, days, accountId]
        );
        writeToLocalLogFile('License', `Account ${accountId} aktywował kod ${code}: ${tier} (${days > 0 ? days + ' dni' : 'bezterminowo'})`);
        // Podniesienie pakietu przywraca poświadczenia zablokowane wcześniej limitem.
        await enforceLicenseLimits(accountId);
        return sendJSON(res, 200, { success: true, tier });
      }

      // =========================================================================
      // ZMIANA NAZWY URZĄDZENIA (np. "Drzwi wejściowe", "Garaż")
      // =========================================================================
      // =========================================================================
      // RESET KLUCZA URZĄDZENIA — POST { mac }, tylko właściciel (README §7.2).
      // Na wypadek wymiany płytki albo gdy klucz przypiął się z innego urządzenia:
      // kasuje zapamiętany hash, a centralka przypina swój przy najbliższym pollu.
      // =========================================================================
      if (pathname === '/api/devices/reset_key' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const mac = normalizeMac(body.mac);
        if (!mac) return sendJSON(res, 400, { error: 'Missing mac' });
        // Właściciel — albo serwis z potwierdzoną (na miejscu) sesją serwisową.
        const svcSess = serviceSessions[mac];
        const viaService = !!(svcSess && svcSess.accountId === accountId && Date.now() < svcSess.confirmedUntil);
        const r = await dbPool.query(
          viaService
            ? 'UPDATE devices SET device_key_hash = NULL WHERE mac_address = $1 RETURNING mac_address'
            : 'UPDATE devices SET device_key_hash = NULL WHERE mac_address = $1 AND account_id = $2 RETURNING mac_address',
          viaService ? [mac] : [mac, accountId]);
        if (r.rows.length === 0) return sendJSON(res, 403, { error: 'Tylko właściciel (lub serwis w potwierdzonej sesji) może zresetować klucz centralki.' });
        writeToLocalLogFile('Provisioning', `[Node: ${mac}] Klucz urządzenia zresetowany przez ${viaService ? 'SERWIS' : 'właściciela'} ${accountId} (IP ${cleanIp}).`);
        return sendJSON(res, 200, { status: 'ok' });
      }

      if (pathname === '/api/devices/rename' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const { mac, name } = body;
        if (!mac || !name) return sendJSON(res, 400, { error: "Missing mac or name" });
        const result = await dbPool.query(
          'UPDATE devices SET device_name = $1 WHERE mac_address = $2 AND account_id = $3 RETURNING mac_address',
          [name.trim(), mac.toUpperCase(), accountId]
        );
        if (result.rows.length === 0) return sendJSON(res, 404, { error: "Device not found on this account" });
        writeToLocalLogFile('Provisioning', `[Node: ${mac.toUpperCase()}] Renamed to "${name.trim()}".`);
        return sendJSON(res, 200, { status: "ok" });
      }

      // =========================================================================
      // CZAS OTWARCIA RYGLA — POST { mac, seconds }. Tylko WŁAŚCICIEL (jak rename/WiFi):
      // to ustawienie bezpieczeństwa, więc współadmin go nie zmienia. Trafia do
      // centralki przy najbliższym pollu jako "auto_lock_delay" (w ms).
      // =========================================================================
      if (pathname === '/api/devices/auto_lock' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const mac = String(body.mac || '').toUpperCase();
        const seconds = parseInt(body.seconds, 10);
        if (!mac) return sendJSON(res, 400, { error: 'Missing mac' });
        // Zakres zgodny z firmware (1–60 s) — poza nim centralka i tak zignoruje wartość.
        if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) {
          return sendJSON(res, 400, { error: 'Czas otwarcia musi mieścić się w zakresie 1–60 sekund.' });
        }
        const result = await dbPool.query(
          'UPDATE devices SET auto_lock_delay_ms = $1 WHERE mac_address = $2 AND account_id = $3 RETURNING mac_address',
          [seconds * 1000, mac, accountId]
        );
        if (result.rows.length === 0) {
          return sendJSON(res, 403, { error: 'Tylko właściciel może zmienić czas otwarcia.' });
        }
        writeToLocalLogFile('Provisioning', `[Node: ${mac}] Czas otwarcia rygla ustawiony na ${seconds}s.`);
        return sendJSON(res, 200, { status: 'ok', seconds });
      }

      // Uwaga: dawny "miękki" endpoint /api/devices/remove usunięto — kasował tylko
      // wiersz w bazie, a centralka i tak rejestrowała się z powrotem przy najbliższym
      // pollu (wysyła ?email= co cykl). Twarde odłączenie realizuje deregistracja poniżej.

      // =========================================================================
      // RODO art. 17 — USUNIĘCIE KONTA, KROK 1: prośba o kod potwierdzający.
      // Decyzja produktowa: właściciel jest superadminem. Usunięcie konta kasuje
      // WSZYSTKIE jego centralki wraz z danymi, a współadministratorzy tracą dostęp
      // (nie są pytani o zgodę). Centralki dostają komendę wipe i wracają do trybu setup.
      // =========================================================================
      if (pathname === '/api/account/delete_request' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;

        const acc = await dbPool.query('SELECT email FROM accounts WHERE id = $1', [accountId]);
        if (acc.rows.length === 0) return sendJSON(res, 404, { error: 'Nie znaleziono konta.' });
        const accEmail = acc.rows[0].email;

        // Ile danych zniknie — pokazujemy w mailu, żeby decyzja była świadoma.
        const owned = await dbPool.query('SELECT mac_address, device_name FROM devices WHERE account_id = $1', [accountId]);
        const shareCount = await dbPool.query(
          `SELECT COUNT(*) FROM device_shares WHERE mac_address IN (SELECT mac_address FROM devices WHERE account_id = $1)`,
          [accountId]);

        const code = genCode6();
        accountDeleteCodes[accountId] = { code, expiresAt: Date.now() + 15 * 60 * 1000, fails: 0 };

        const deviceList = owned.rows.length > 0
          ? owned.rows.map(d => `<li>${escapeHtml(d.device_name || d.mac_address)}</li>`).join('')
          : '<li><i>brak przypisanych centralek</i></li>';

        mailTransport.sendMail({
          from: '"CTRLABLE Node System" <node@ctrlable.pl>',
          to: accEmail,
          subject: 'Potwierdzenie USUNIĘCIA KONTA CTRLABLE',
          html: `<div style="font-family:sans-serif; max-width:600px; margin:0 auto; color:#333;">
                 <h2 style="color:#c62828;">Żądanie trwałego usunięcia konta</h2>
                 <p>Otrzymaliśmy prośbę o usunięcie konta <b>${escapeHtml(accEmail)}</b>. Operacja jest <b>nieodwracalna</b>.</p>
                 <p><b>Zostaną trwale usunięte:</b></p>
                 <ul>
                   <li>konto wraz z danymi logowania</li>
                   <li>wszystkie karty RFID i kody PIN</li>
                   <li>cała historia wejść i zdarzeń</li>
                   <li>aktywna licencja (bez zwrotu okresu)</li>
                 </ul>
                 <p><b>Twoje centralki (${owned.rows.length}) zostaną odłączone i zresetowane do ustawień fabrycznych:</b></p>
                 <ul>${deviceList}</ul>
                 ${parseInt(shareCount.rows[0].count) > 0
                   ? `<p style="color:#c62828;"><b>Uwaga:</b> ${shareCount.rows[0].count} współadministrator(ów) straci dostęp do Twoich centralek.</p>`
                   : ''}
                 <p>Aby potwierdzić, wpisz w aplikacji ten kod:</p>
                 <h1 style="color:#c62828; font-family:monospace; letter-spacing:4px;">${code}</h1>
                 <p style="font-size:12px; color:#888;">Kod ważny 15 minut. Jeśli to nie Ty — zignoruj tę wiadomość, nic się nie stanie.</p>
                 </div>`
        }, (err) => { if (err) writeToLocalLogFile('Błąd serwera SMTP', err.message); });

        writeToLocalLogFile('Authentication Panel', `RODO: żądanie usunięcia konta ${accEmail} (id=${accountId}), centralek: ${owned.rows.length}.`);
        return sendJSON(res, 200, { status: 'ok', devices: owned.rows.length, coAdmins: parseInt(shareCount.rows[0].count) });
      }

      // =========================================================================
      // RODO art. 17 — USUNIĘCIE KONTA, KROK 2: potwierdzenie kodem → kasacja.
      // =========================================================================
      if (pathname === '/api/account/delete_confirm' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const code = String(body.code || '').trim();
        if (!code) return sendJSON(res, 400, { error: 'Brak kodu potwierdzającego.' });

        const pending = accountDeleteCodes[accountId];
        if (!pending || pending.code !== code || Date.now() > pending.expiresAt) {
          if (pending && ++pending.fails >= CODE_MAX_ATTEMPTS) delete accountDeleteCodes[accountId];
          return sendJSON(res, 400, { error: 'Kod jest nieprawidłowy lub wygasł.' });
        }

        const acc = await dbPool.query('SELECT email FROM accounts WHERE id = $1', [accountId]);
        if (acc.rows.length === 0) return sendJSON(res, 404, { error: 'Nie znaleziono konta.' });
        const accEmail = acc.rows[0].email;

        const owned = await dbPool.query('SELECT mac_address FROM devices WHERE account_id = $1', [accountId]);
        const macs = owned.rows.map(r => r.mac_address);

        // 1) Dane przypięte do centralek właściciela (kolejność: dzieci → rodzic).
        for (const mac of macs) {
          // Komenda wipe — centralka wyczyści EEPROM+LittleFS przy najbliższym pollu.
          // Planujemy ją PRZED skasowaniem wiersza (potrzebny hash klucza urządzenia).
          await scheduleDeviceWipe(mac);
          await dbPool.query('DELETE FROM device_commands  WHERE mac_address = $1', [mac]).catch(() => {});
          await dbPool.query('DELETE FROM keypad_pins      WHERE mac_address = $1', [mac]);
          await dbPool.query('DELETE FROM card_credentials WHERE mac_address = $1', [mac]);
          await dbPool.query('DELETE FROM system_events    WHERE mac_address = $1', [mac]);
          await dbPool.query('DELETE FROM device_shares    WHERE mac_address = $1', [mac]);
          await dbPool.query('DELETE FROM device_invites   WHERE mac_address = $1', [mac]);
          await dbPool.query('DELETE FROM pin_change_events WHERE mac_address = $1', [mac]).catch(() => {});
          await dbPool.query('DELETE FROM devices          WHERE mac_address = $1', [mac]);
        }

        // 2) Dostępy tego konta do CUDZYCH centralek (jako współadmin) — też znikają.
        await dbPool.query('DELETE FROM device_shares WHERE account_id = $1', [accountId]);
        await dbPool.query('DELETE FROM device_invites WHERE invited_by = $1', [accountId]).catch(() => {});
        await dbPool.query('DELETE FROM pin_change_events WHERE account_id = $1', [accountId]).catch(() => {});

        // 3) Tombstone — hash e-maila (NIE sam e-mail, żeby nie tworzyć nowego zbioru
        //    danych osobowych). Służy do ponownego zastosowania usunięcia, gdyby
        //    kiedykolwiek odtworzono kopię zapasową sprzed kasacji.
        const emailHash = crypto.createHash('sha256').update(accEmail).digest('hex');
        await dbPool.query(
          'INSERT INTO erasure_requests (email_hash, account_id, requested_at) VALUES ($1, $2, NOW())',
          [emailHash, accountId]
        ).catch((e) => writeToLocalLogFile('Core Daemon', `[RODO] Nie zapisano tombstone: ${e.message}`));

        // 4) Samo konto (license_codes.used_by i tak ma ON DELETE SET NULL).
        await dbPool.query('DELETE FROM accounts WHERE id = $1', [accountId]);
        delete accountDeleteCodes[accountId];

        writeToLocalLogFile('Authentication Panel', `RODO: konto id=${accountId} USUNIĘTE. Centralek zresetowanych: ${macs.length}.`);
        return sendJSON(res, 200, { status: 'deleted', devicesWiped: macs.length });
      }

      // =========================================================================
      // RODO art. 20 — EKSPORT DANYCH (prawo do przenoszenia). Zwraca komplet
      // danych konta w JSON-ie; aplikacja pozwala go zapisać/udostępnić.
      // =========================================================================
      if (pathname === '/api/account/export' && req.method === 'GET') {
        const accountId = await requireAuth(req, res); if (!accountId) return;

        const acc = await dbPool.query(
          `SELECT email, privacy_policy_accepted_at, license_tier, license_valid_until, email_verified
             FROM accounts WHERE id = $1`, [accountId]);
        if (acc.rows.length === 0) return sendJSON(res, 404, { error: 'Nie znaleziono konta.' });

        const devs = await dbPool.query(
          'SELECT mac_address, device_name, operational_mode, firmware_version, last_heartbeat FROM devices WHERE account_id = $1',
          [accountId]);
        const macs = devs.rows.map(r => r.mac_address);

        const cards = macs.length ? (await dbPool.query(
          `SELECT mac_address, holder_name, card_uid, is_active, schedule_enabled, schedule_days,
                  schedule_start_minutes, schedule_end_minutes
             FROM card_credentials WHERE mac_address = ANY($1)`, [macs])).rows : [];
        // PIN-y BEZ hashy — hash to dane uwierzytelniające, nie treść do wydania.
        const pins = macs.length ? (await dbPool.query(
          `SELECT mac_address, name, active, is_guest_code, expires_at, max_uses, use_count, created_at
             FROM keypad_pins WHERE mac_address = ANY($1)`, [macs])).rows : [];
        const events = macs.length ? (await dbPool.query(
          `SELECT mac_address, event_time, message, category FROM system_events
            WHERE mac_address = ANY($1) ORDER BY event_time DESC LIMIT 5000`, [macs])).rows : [];
        const shares = macs.length ? (await dbPool.query(
          `SELECT ds.mac_address, a.email AS admin_email, ds.created_at
             FROM device_shares ds JOIN accounts a ON a.id = ds.account_id
            WHERE ds.mac_address = ANY($1)`, [macs])).rows : [];

        writeToLocalLogFile('Authentication Panel', `RODO: eksport danych konta id=${accountId}.`);
        return sendJSON(res, 200, {
          exported_at: new Date().toISOString(),
          account: acc.rows[0],
          devices: devs.rows,
          cards, keypad_pins: pins, co_admins: shares,
          events_note: 'Historia zdarzeń ograniczona do 5000 najnowszych wpisów.',
          events
        });
      }

      // =========================================================================
      // DEREGISTRACJA — KROK 1: właściciel prosi o kod potwierdzający (mail)
      // POST { mac } — tylko właściciel. Twarde odłączenie centralki.
      // =========================================================================
      if (pathname === '/api/devices/deregister_request' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const mac = String(body.mac || '').toUpperCase();
        if (!mac) return sendJSON(res, 400, { error: 'Missing mac' });

        const owned = await dbPool.query(
          `SELECT d.device_name, a.email FROM devices d JOIN accounts a ON a.id = d.account_id
           WHERE d.mac_address = $1 AND d.account_id = $2`, [mac, accountId]);
        if (owned.rows.length === 0) return sendJSON(res, 403, { error: 'Tylko właściciel może odłączyć centralkę.' });

        const code = genCode6();
        deregisterCodes[mac] = { code, accountId, expiresAt: Date.now() + 15 * 60 * 1000, fails: 0 };

        const deviceName = owned.rows[0].device_name || mac;
        mailTransport.sendMail({
          from: '"CTRLABLE Node System" <node@ctrlable.pl>',
          to: owned.rows[0].email,
          subject: `Potwierdzenie odłączenia centralki: ${deviceName}`,
          html: `<div style="font-family:sans-serif; max-width:600px; margin:0 auto; color:#333;">
                 <h3>Prośba o odłączenie centralki „${escapeHtml(deviceName)}"</h3>
                 <p>Aby potwierdzić <b>trwałe odłączenie i reset</b> tej centralki, wpisz w aplikacji poniższy kod:</p>
                 <h1 style="color:#0284c7; font-family:monospace; letter-spacing:2px;">${code}</h1>
                 <p>Po potwierdzeniu centralka wyczyści swoją konfigurację (WiFi, konto, karty RFID) i wróci do trybu
                 konfiguracji. Ponowne połączenie będzie wymagać skonfigurowania jej od nowa (CTRLABLE_SETUP).</p>
                 <p style="font-size:12px; color:#888;">Kod jest ważny 15 minut. Jeśli to nie Ty, zignoruj tę wiadomość — nic się nie stanie.</p>
                 </div>`
        }, (err) => { if (err) writeToLocalLogFile('Błąd serwera SMTP', err.message); });

        writeToLocalLogFile('Provisioning', `[Node: ${mac}] Deregister code requested by owner ${accountId}.`);
        return sendJSON(res, 200, { status: 'ok' });
      }

      // =========================================================================
      // DEREGISTRACJA — KROK 2: potwierdzenie kodem → usunięcie danych + komenda wipe
      // POST { mac, code } — tylko właściciel.
      // =========================================================================
      if (pathname === '/api/devices/deregister_confirm' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const mac = String(body.mac || '').toUpperCase();
        const code = String(body.code || '').trim();
        if (!mac || !code) return sendJSON(res, 400, { error: 'Missing mac or code' });

        const entry = deregisterCodes[mac];
        if (!entry || entry.accountId !== accountId || entry.code !== code || Date.now() > entry.expiresAt) {
          if (entry && entry.accountId === accountId && ++entry.fails >= CODE_MAX_ATTEMPTS) delete deregisterCodes[mac];
          return sendJSON(res, 400, { error: 'Kod nieprawidłowy lub wygasł.' });
        }
        const owned = await dbPool.query('SELECT 1 FROM devices WHERE mac_address = $1 AND account_id = $2', [mac, accountId]);
        if (owned.rows.length === 0) return sendJSON(res, 403, { error: 'Tylko właściciel może odłączyć centralkę.' });

        // Wipe planujemy PRZED usunięciem wiersza (zapamiętuje hash klucza urządzenia).
        await scheduleDeviceWipe(mac);

        // Usuwamy dane powiązane jawnie (na wypadek braku ON DELETE CASCADE), potem centralkę.
        await dbPool.query('DELETE FROM keypad_pins WHERE mac_address = $1', [mac]).catch(() => {});
        await dbPool.query('DELETE FROM card_credentials WHERE mac_address = $1', [mac]).catch(() => {});
        await dbPool.query('DELETE FROM system_events WHERE mac_address = $1', [mac]).catch(() => {});
        await dbPool.query('DELETE FROM device_shares WHERE mac_address = $1', [mac]).catch(() => {});
        await dbPool.query('DELETE FROM device_invites WHERE mac_address = $1', [mac]).catch(() => {});
        await dbPool.query('DELETE FROM device_commands WHERE mac_address = $1', [mac]).catch(() => {});
        await dbPool.query('DELETE FROM devices WHERE mac_address = $1 AND account_id = $2', [mac, accountId]);

        // Komenda wipe (zaplanowana wyżej) + krótka blokada auto-rejestracji: okno na odebranie
        // komendy (urządzenie pyta co ~1 s). Krótkie, by nie blokować późniejszego re-prowizjonowania.
        delete deregisterCodes[mac];

        writeToLocalLogFile('Provisioning', `[Node: ${mac}] Deregistered by owner ${accountId} — device wipe commanded.`);
        return sendJSON(res, 200, { status: 'ok' });
      }

      // =========================================================================
      // ZAPROSZENIE WSPÓŁADMINISTRATORA (wielu administratorów na jeden zamek)
      // Tylko WŁAŚCICIEL urządzenia (devices.account_id) może zapraszać.
      // POST { mac, email }
      // =========================================================================
      if (pathname === '/api/devices/invite' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const waitSec = checkRateLimit(inviteAttempts, cleanIp, 10, 60 * 60 * 1000);
        if (waitSec > 0) {
          res.setHeader('Retry-After', String(waitSec));
          return sendJSON(res, 429, { error: `Zbyt wiele zaproszeń. Spróbuj ponownie za ${Math.ceil(waitSec/60)} min.` });
        }

        const { mac, email } = body;
        const cleanEmail = (email || '').trim().toLowerCase();
        if (!mac || !cleanEmail) return sendJSON(res, 400, { error: 'Podaj adres e-mail' });

        // Tylko właściciel może zapraszać — celowo NIE przez resolveTargetDevice
        // (który wpuściłby też już zaproszonych administratorów).
        const ownedDevice = await dbPool.query(
          'SELECT mac_address, device_name FROM devices WHERE mac_address = $1 AND account_id = $2',
          [mac.toUpperCase(), accountId]
        );
        if (ownedDevice.rows.length === 0) return sendJSON(res, 403, { error: 'Tylko właściciel może zapraszać administratorów.' });

        // Limit administratorów wg pakietu (łącznie z właścicielem). Liczymy
        // istniejących współadminów + oczekujące niewykorzystane zaproszenia + 1.
        // KONTO SERWISOWE (README §7.15) omija limit administratorów: klient z pełnym
        // pakietem nie może być zmuszony do usuwania kogoś, żeby na chwilę wpuścić serwis.
        // Udziały serwisowe i zaproszenia dla serwisu nie są też liczone do limitu.
        const inviteIsService = isServiceEmail(cleanEmail);
        if (!inviteIsService) {
          const adEnt = await getEntitlements(accountId);
          const shCnt = await dbPool.query(
            `SELECT COUNT(*) FROM device_shares WHERE mac_address = $1 AND is_service = false AND ${SHARE_ACTIVE}`, [mac.toUpperCase()]);
          const pendCnt = await dbPool.query(
            `SELECT COUNT(*) FROM device_invites di WHERE di.mac_address = $1 AND di.used = false AND di.expires_at > NOW()
                AND NOT (LOWER(di.invited_email) = ANY($2))`,
            [mac.toUpperCase(), Array.from(SERVICE_ACCOUNTS)]);
          const adminTotal = parseInt(shCnt.rows[0].count) + parseInt(pendCnt.rows[0].count) + 1;
          if (adminTotal >= adEnt.max_admins)
            return sendJSON(res, 403, {
              error: `Limit administratorów (${adEnt.max_admins}) osiągnięty w pakiecie ${adEnt.license_tier}. Zwiększ pakiet, aby zaprosić kolejnych.`,
              limit: adEnt.max_admins, tier: adEnt.license_tier, feature: 'max_admins'
            });
        }

        const inviteCode = genCode6();
        const inviteToken = crypto.randomBytes(24).toString('hex');   // 48-znakowy token linku
        await dbPool.query(
          `INSERT INTO device_invites (mac_address, invited_email, invite_code, invite_token, invited_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '48 hours')`,
          [mac.toUpperCase(), cleanEmail, inviteCode, inviteToken, accountId]
        );

        const deviceName = ownedDevice.rows[0].device_name || mac.toUpperCase();
        const inviteLink = `${PUBLIC_BASE_URL}/invite?token=${inviteToken}`;
        const inviteMailManifest = {
          from: '"CTRLABLE Node System" <node@ctrlable.pl>',
          to: cleanEmail,
          subject: `Zaproszenie do współadministrowania: ${deviceName}`,
          html: `<div style="font-family:sans-serif; max-width:600px; margin:0 auto; color:#333;">
                 <h3>Zostałeś zaproszony do współadministrowania centralką „${escapeHtml(deviceName)}”.</h3>
                 <p>Kliknij poniższy przycisk, aby utworzyć konto i uzyskać dostęp:</p>
                 <p style="margin:24px 0;">
                   <a href="${inviteLink}" style="background:#0284c7; color:#fff; text-decoration:none;
                      padding:12px 24px; border-radius:8px; font-weight:bold; display:inline-block;">
                      Przyjmij zaproszenie
                   </a>
                 </p>
                 <p style="font-size:12px; color:#888;">Jeśli przycisk nie działa, skopiuj ten adres do przeglądarki:<br>
                   <span style="font-family:monospace;">${inviteLink}</span></p>
                 <hr style="border:none; border-top:1px solid #eee; margin:20px 0;">
                 <p style="font-size:12px; color:#888;">Masz już konto CTRLABLE na tym adresie? Zaloguj się w aplikacji
                   i w zakładce „Zespół" użyj kodu:
                   <b style="font-family:monospace; letter-spacing:1px;">${inviteCode}</b></p>
                 <p style="font-size:12px; color:#888;">Zaproszenie jest ważne przez 48 godzin.</p>
                 </div>`
        };
        mailTransport.sendMail(inviteMailManifest, (mailError) => {
          if (mailError) writeToLocalLogFile('Błąd serwera SMTP', mailError.message);
        });

        writeToLocalLogFile('Provisioning', `[Node: ${mac.toUpperCase()}] Invite sent to ${cleanEmail} by account ${accountId}${inviteIsService ? ' (SERWIS — poza limitem, wygasa po ' + SERVICE_SHARE_HOURS + ' h)' : ''}.`);
        return sendJSON(res, 200, { status: 'ok', service: inviteIsService, serviceShareHours: inviteIsService ? SERVICE_SHARE_HOURS : null });
      }

      // =========================================================================
      // AKCEPTACJA ZAPROSZENIA — POST { code }, wymaga zalogowania
      // =========================================================================
      if (pathname === '/api/devices/accept_invite' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const { code } = body;
        if (!code) return sendJSON(res, 400, { error: 'Podaj kod zaproszenia' });
        if (checkRateLimit(inviteAttempts, `accept:${accountId}`, 10, 60 * 60 * 1000) > 0) {
          return sendJSON(res, 429, { error: 'Zbyt wiele prób. Spróbuj ponownie później.' });
        }

        const accRes = await dbPool.query('SELECT email FROM accounts WHERE id = $1', [accountId]);
        if (accRes.rows.length === 0) return sendJSON(res, 404, { error: 'Konto nie istnieje' });
        const myEmail = accRes.rows[0].email.toLowerCase();

        const inviteRes = await dbPool.query(
          `SELECT id, mac_address, invited_email FROM device_invites
           WHERE invite_code = $1 AND used = false AND expires_at > NOW()`,
          [String(code).trim()]
        );
        if (inviteRes.rows.length === 0) return sendJSON(res, 400, { error: 'Kod nieprawidłowy lub wygasł.' });

        const invite = inviteRes.rows[0];
        if (invite.invited_email.toLowerCase() !== myEmail) {
          return sendJSON(res, 403, { error: 'To zaproszenie zostało wysłane na inny adres e-mail.' });
        }

        const grant = await grantShare(invite.mac_address, accountId, invite.id, myEmail);
        await dbPool.query('UPDATE device_invites SET used = true WHERE id = $1', [invite.id]);

        writeToLocalLogFile('Provisioning', `[Node: ${invite.mac_address}] Account ${accountId} accepted invite, now ${grant.service ? 'SERVICE co-admin (expires ' + grant.expiresAt + ')' : 'co-admin'}.`);
        return sendJSON(res, 200, { status: 'ok', mac: invite.mac_address, service: grant.service, expiresAt: grant.expiresAt });
      }

      // =========================================================================
      // LISTA WSPÓŁADMINISTRATORÓW — GET ?mac=X, tylko właściciel
      // =========================================================================
      if (pathname === '/api/devices/shared_users' && req.method === 'GET') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const mac = (query.mac || '').toUpperCase();
        if (!mac) return sendJSON(res, 400, { error: 'Missing mac' });

        const ownedDevice = await dbPool.query('SELECT 1 FROM devices WHERE mac_address = $1 AND account_id = $2', [mac, accountId]);
        if (ownedDevice.rows.length === 0) return sendJSON(res, 403, { error: 'Tylko właściciel widzi listę administratorów.' });

        const sharesRes = await dbPool.query(
          `SELECT ds.account_id, a.email, ds.created_at, ds.is_service, ds.expires_at
           FROM device_shares ds JOIN accounts a ON a.id = ds.account_id
           WHERE ds.mac_address = $1 AND ${SHARE_ACTIVE} ORDER BY ds.created_at ASC`, [mac]
        );
        return sendJSON(res, 200, { admins: sharesRes.rows.map(r => ({
          accountId: r.account_id, email: r.email, since: r.created_at,
          service: !!r.is_service, expiresAt: r.expires_at || null,
        })) });
      }

      // =========================================================================
      // ODEBRANIE DOSTĘPU WSPÓŁADMINISTRATOROWI — POST { mac, accountId }, tylko właściciel
      // =========================================================================
      if (pathname === '/api/devices/revoke_share' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const { mac, accountId: targetAccountId } = body;
        if (!mac || !targetAccountId) return sendJSON(res, 400, { error: 'Missing mac or accountId' });

        const ownedDevice = await dbPool.query('SELECT 1 FROM devices WHERE mac_address = $1 AND account_id = $2', [mac.toUpperCase(), accountId]);
        if (ownedDevice.rows.length === 0) return sendJSON(res, 403, { error: 'Tylko właściciel może odbierać dostęp.' });

        await dbPool.query('DELETE FROM device_shares WHERE mac_address = $1 AND account_id = $2', [mac.toUpperCase(), targetAccountId]);
        writeToLocalLogFile('Provisioning', `[Node: ${mac.toUpperCase()}] Access revoked for account ${targetAccountId} by owner ${accountId}.`);
        return sendJSON(res, 200, { status: 'ok' });
      }

      // =========================================================================
      // WSPÓŁADMIN ODŁĄCZA SIĘ SAM — POST { mac }. Serwis sprząta po sobie bez
      // czekania na właściciela (README §7.15); działa też dla zwykłego współadmina.
      // =========================================================================
      if (pathname === '/api/devices/leave' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const mac = normalizeMac(body.mac);
        if (!mac) return sendJSON(res, 400, { error: 'Missing mac' });
        const r = await dbPool.query('DELETE FROM device_shares WHERE mac_address = $1 AND account_id = $2 RETURNING is_service', [mac, accountId]);
        if (r.rows.length === 0) return sendJSON(res, 404, { error: 'Nie masz udziału w tej centralce.' });
        if (serviceSessions[mac] && serviceSessions[mac].accountId === accountId) delete serviceSessions[mac];
        writeToLocalLogFile('Provisioning', `[Node: ${mac}] Account ${accountId} left the device${r.rows[0].is_service ? ' (service)' : ''}.`);
        await dbPool.query('INSERT INTO system_events (mac_address, message, category) VALUES ($1, $2, $3)',
          [mac, r.rows[0].is_service ? 'Serwis zakończył dostęp do centralki' : 'Współadministrator odłączył się od centralki', 'provisioning']).catch(() => {});
        return sendJSON(res, 200, { status: 'ok' });
      }

      // =========================================================================
      // TRYB SERWISOWY (README §7.15) — tylko konta z SERVICE_ACCOUNTS, tylko na
      // centralce, którą klient im udostępnił, a rozszerzone akcje dopiero po
      // przepisaniu kodu z OLED centralki (dowód obecności fizycznej).
      // =========================================================================
      if (pathname === '/api/service/start' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const svc = await requireServiceShare(accountId, body.mac, res); if (!svc) return;
        const code = genCode6();
        serviceSessions[svc.mac] = { accountId, code, codeUntil: Date.now() + 15 * 60 * 1000, confirmedUntil: 0, fails: 0 };
        await queueDeviceCommand(svc.mac, `V|${code}`);          // centralka pokaże kod na OLED
        await dbPool.query('INSERT INTO system_events (mac_address, message, category) VALUES ($1, $2, $3)',
          [svc.mac, 'Rozpoczęto sesję serwisową — oczekiwanie na potwierdzenie kodem z centralki', 'provisioning']).catch(() => {});
        notifyOwner(svc.mac, '🛠️ Serwis centralki', `Serwisant rozpoczął sesję na centralce ${svc.deviceName}. Potwierdzenie wymaga kodu z jej ekranu.`);
        writeToLocalLogFile('Service', `[Node: ${svc.mac}] Service session started by ${accountId} (IP ${cleanIp}); code sent to device.`);
        return sendJSON(res, 200, { status: 'code_sent', codeValidSeconds: 900 });
      }

      if (pathname === '/api/service/confirm' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const svc = await requireServiceShare(accountId, body.mac, res); if (!svc) return;
        const s = serviceSessions[svc.mac];
        const code = String(body.code || '').trim();
        if (!s || s.accountId !== accountId || Date.now() > s.codeUntil) {
          return sendJSON(res, 400, { error: 'Brak aktywnego kodu — rozpocznij sesję ponownie.' });
        }
        if (code !== s.code) {
          if (++s.fails >= CODE_MAX_ATTEMPTS) {
            delete serviceSessions[svc.mac];
            writeToLocalLogFile('Auth RateLimit', `[Node: ${svc.mac}] Service code burned after ${CODE_MAX_ATTEMPTS} wrong attempts (account ${accountId}).`);
            return sendJSON(res, 429, { error: 'Za dużo błędnych prób — kod unieważniony. Rozpocznij sesję ponownie.' });
          }
          return sendJSON(res, 400, { error: 'Kod nieprawidłowy.' });
        }
        s.confirmedUntil = Date.now() + 60 * 60 * 1000;
        s.code = null;
        await dbPool.query('INSERT INTO system_events (mac_address, message, category) VALUES ($1, $2, $3)',
          [svc.mac, 'Sesja serwisowa potwierdzona kodem z centralki (obecność na miejscu)', 'provisioning']).catch(() => {});
        writeToLocalLogFile('Service', `[Node: ${svc.mac}] Service session CONFIRMED on-site by ${accountId}.`);
        return sendJSON(res, 200, { status: 'confirmed', validSeconds: 3600 });
      }

      if (pathname === '/api/service/end' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const mac = normalizeMac(body.mac);
        if (mac && serviceSessions[mac] && serviceSessions[mac].accountId === accountId) {
          delete serviceSessions[mac];
          await dbPool.query('INSERT INTO system_events (mac_address, message, category) VALUES ($1, $2, $3)',
            [mac, 'Sesja serwisowa zakończona', 'provisioning']).catch(() => {});
        }
        return sendJSON(res, 200, { status: 'ok' });
      }

      // Akcje serwisowe — POST { mac, action }: diagnostics (pełny raport z listą kart),
      // relay_test (raport + krótkie wysterowanie przekaźnika — OTWIERA DRZWI), restart.
      if (pathname === '/api/service/command' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const svc = await requireServiceSession(accountId, body.mac, res); if (!svc) return;
        const action = String(body.action || '');
        const cmd = { diagnostics: 'G|1', relay_test: 'G|2', restart: 'R' }[action];
        if (!cmd) return sendJSON(res, 400, { error: 'Nieznana akcja.' });
        await queueDeviceCommand(svc.mac, cmd);
        await dbPool.query('INSERT INTO system_events (mac_address, message, category) VALUES ($1, $2, $3)',
          [svc.mac, `Serwis: ${{ diagnostics: 'pobranie diagnostyki', relay_test: 'test przekaźnika', restart: 'restart centralki' }[action]}`, 'provisioning']).catch(() => {});
        writeToLocalLogFile('Service', `[Node: ${svc.mac}] Service action '${action}' queued by ${accountId}.`);
        return sendJSON(res, 200, { status: 'queued' });
      }

      // Ostatni raport diagnostyczny centralki — pełny (z kartami) + porównanie kart z bazą.
      if (pathname === '/api/service/report' && req.method === 'GET') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const svc = await requireServiceSession(accountId, query.mac, res); if (!svc) return;
        const rep = await latestDeviceReport(svc.mac);
        if (!rep) return sendJSON(res, 200, { report: null });
        const payload = rep.payload;
        const dbCards = (await dbPool.query(
          'SELECT id, holder_name, card_uid, is_active FROM card_credentials WHERE mac_address = $1 ORDER BY id ASC', [svc.mac])).rows;
        const devCards = Array.isArray(payload.cards) ? payload.cards : [];
        const devByUid = new Map(devCards.map(c => [String(c.u || '').toUpperCase(), c]));
        const dbByUid = new Map(dbCards.map(c => [uidToHex8(c.card_uid), c]));
        const comparison = {
          onlyOnDevice: devCards.filter(c => !dbByUid.has(String(c.u || '').toUpperCase())).map(c => ({ name: c.n, uidTail: String(c.u || '').slice(-4), active: !!c.a })),
          onlyInDb: dbCards.filter(c => !devByUid.has(uidToHex8(c.card_uid))).map(c => ({ id: c.id, name: c.holder_name, uidTail: uidToHex8(c.card_uid).slice(-4), active: !!c.is_active })),
          activeMismatch: dbCards.filter(c => devByUid.has(uidToHex8(c.card_uid)) && !!devByUid.get(uidToHex8(c.card_uid)).a !== !!c.is_active)
            .map(c => ({ id: c.id, name: c.holder_name, dbActive: !!c.is_active, deviceActive: !!devByUid.get(uidToHex8(c.card_uid)).a })),
          deviceCount: devCards.length, dbCount: dbCards.length,
        };
        return sendJSON(res, 200, {
          report: { at: rep.created_at, kind: rep.kind, raw: payload, checks: evaluateReport(payload), comparison,
                    pendingCommands: await pendingCommandCount(svc.mac).catch(() => 0) },
        });
      }

      // =========================================================================
      // SELF-TEST DLA KLIENTA — właściciel lub współadmin. Tylko odczyt: BEZ testu
      // przekaźnika (ten otwiera drzwi) i BEZ listy kart w odpowiedzi. Raport prostym
      // językiem + zalecenie serwisu, gdy któryś komponent zgłasza problem.
      // =========================================================================
      if (pathname === '/api/devices/selftest' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const dev = await resolveTargetDevice(accountId, body.mac, 'mac_address');
        if (dev.rows.length === 0) return sendJSON(res, 403, { error: 'Brak dostępu do tej centralki.' });
        const mac = dev.rows[0].mac_address;
        if (checkRateLimit(selftestAttempts, mac, 1, 60 * 1000) > 0) {
          return sendJSON(res, 429, { error: 'Self-test można uruchamiać raz na minutę.' });
        }
        await queueDeviceCommand(mac, 'G|0');
        await dbPool.query('INSERT INTO system_events (mac_address, message, category) VALUES ($1, $2, $3)',
          [mac, 'Uruchomiono self-test centralki', 'provisioning']).catch(() => {});
        return sendJSON(res, 200, { status: 'queued', requestedAt: new Date().toISOString() });
      }

      if (pathname === '/api/devices/selftest' && req.method === 'GET') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const dev = await resolveTargetDevice(accountId, query.mac, 'mac_address');
        if (dev.rows.length === 0) return sendJSON(res, 403, { error: 'Brak dostępu do tej centralki.' });
        const rep = await latestDeviceReport(dev.rows[0].mac_address);
        if (!rep) return sendJSON(res, 200, { report: null });
        const checks = evaluateReport(rep.payload);
        const failed = checks.filter(c => c.ok === false);
        return sendJSON(res, 200, {
          report: {
            at: rep.created_at,
            checks,
            firmware: rep.payload.fw || null,
            summary: failed.length === 0
              ? 'Wszystkie komponenty centralki działają prawidłowo.'
              : `Wykryto problem: ${failed.map(c => c.label).join(', ')}. Zalecany kontakt z serwisem.`,
            serviceRecommended: failed.length > 0,
          },
        });
      }

      // =========================================================================
      // STRONA AKCEPTACJI ZAPROSZENIA (link z maila) — GET /invite?token=...
      // Renderowana po stronie serwera, otwierana w przeglądarce. Bez JWT.
      // =========================================================================
      if (pathname === '/invite' && req.method === 'GET') {
        const token = String(query.token || '');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (!token) { res.end(renderInvitePage({ error: 'Brak tokenu zaproszenia w adresie.' })); return; }
        try {
          const inv = await dbPool.query(
            `SELECT di.mac_address, di.invited_email, di.used, di.expires_at, d.device_name
             FROM device_invites di JOIN devices d ON d.mac_address = di.mac_address
             WHERE di.invite_token = $1`, [token]);
          if (inv.rows.length === 0) { res.end(renderInvitePage({ error: 'Zaproszenie nie istnieje lub zostało odwołane.' })); return; }
          const row = inv.rows[0];
          if (row.used) { res.end(renderInvitePage({ error: 'To zaproszenie zostało już wykorzystane.' })); return; }
          if (new Date(row.expires_at) < new Date()) { res.end(renderInvitePage({ error: 'To zaproszenie wygasło.' })); return; }
          res.end(renderInvitePage({ token, email: row.invited_email, deviceName: row.device_name || row.mac_address }));
        } catch (err) {
          writeToLocalLogFile('Invite Page ERROR', String(err));
          res.end(renderInvitePage({ error: 'Wewnętrzny błąd serwera.' }));
        }
        return;
      }

      // =========================================================================
      // AKCEPTACJA ZAPROSZENIA PRZEZ STRONĘ WWW — POST /api/devices/accept_via_web
      // { token, password, privacy_policy_accepted }
      // Tworzy konto (jeśli nie istnieje) i nadaje współadministrację (device_shares).
      // =========================================================================
      if (pathname === '/api/devices/accept_via_web' && req.method === 'POST') {
        const { token, password, privacy_policy_accepted } = body;
        if (!token || !password) return sendJSON(res, 400, { error: 'Brak danych.' });
        if (!privacy_policy_accepted) return sendJSON(res, 400, { error: 'Wymagana akceptacja polityki prywatności.' });
        if (String(password).length < MIN_PASSWORD_LENGTH) return sendJSON(res, 400, { error: `Hasło musi mieć co najmniej ${MIN_PASSWORD_LENGTH} znaków.` });

        try {
          const inv = await dbPool.query(
            `SELECT id, mac_address, invited_email FROM device_invites
             WHERE invite_token = $1 AND used = false AND expires_at > NOW()`, [String(token)]);
          if (inv.rows.length === 0) return sendJSON(res, 400, { error: 'Zaproszenie nieprawidłowe lub wygasłe.' });
          const invite = inv.rows[0];
          const email = invite.invited_email.toLowerCase();

          // Konto na tym adresie może już istnieć — wtedy NIE zmieniamy hasła,
          // tylko nadajemy dostęp (użytkownik loguje się dotychczasowym hasłem).
          const existing = await dbPool.query('SELECT id FROM accounts WHERE email = $1', [email]);
          let targetAccountId;
          const alreadyExisted = existing.rows.length > 0;
          if (alreadyExisted) {
            targetAccountId = existing.rows[0].id;
          } else {
            const hash = await bcrypt.hash(String(password), 10);
            const insAcc = await dbPool.query(
              'INSERT INTO accounts (email, password_hash, privacy_policy_accepted_at) VALUES ($1, $2, NOW()) RETURNING id',
              [email, hash]);
            targetAccountId = insAcc.rows[0].id;
          }

          await grantShare(invite.mac_address, targetAccountId, invite.id, email);
          await dbPool.query('UPDATE device_invites SET used = true WHERE id = $1', [invite.id]);

          writeToLocalLogFile('Provisioning',
            `[Node: ${invite.mac_address}] Web-accept: account ${targetAccountId} (${email}) is now co-admin${alreadyExisted ? ' (existing account)' : ' (new account)'}.`);
          return sendJSON(res, 200, { status: 'ok', existed: alreadyExisted });
        } catch (err) {
          writeToLocalLogFile('Accept Web ERROR', String(err));
          return sendJSON(res, 500, { error: 'Wewnętrzny błąd serwera.' });
        }
      }

      if (pathname === '/api/unlock' && req.method === 'GET') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const devRes = await resolveTargetDevice(accountId, query.mac, 'mac_address');
        if (devRes.rows.length > 0) {
          const targetMac = devRes.rows[0].mac_address;

          // TYLKO ta centralka. Wcześniej ustawiano też unlockQueues['00:00:00:00:00:00'],
          // które sprawdzał poll KAŻDEJ centralki — zdalne otwarcie u jednego klienta
          // otwierało drzwi pierwszego innego klienta, który odpytał serwer w ciągu 8 s.
          unlockQueues[targetMac] = true;

          // 🌟 Zapisujemy TYLKO czas zgłoszenia komendy. Realny stan rygla
          // (`actualLockStates`) zostanie zaktualizowany wyłącznie wtedy, gdy
          // sprzęt sam potwierdzi otwarcie na kolejnym pollu (pole "opened").
          // Dzięki temu aplikacja nigdy nie pokaże "OTWARTY" zanim zamek
          // faktycznie się fizycznie odblokuje.
          pendingUnlocks[targetMac] = Date.now();

          await dbPool.query('INSERT INTO system_events (mac_address, message, category) VALUES ($1, $2, $3)', [targetMac, 'Zdalne wywołanie Mobile', 'entries']);
          writeToLocalLogFile('API Control Command', `[Node: ${targetMac}] Dispatched remote unlock trigger.`);

          // Powiadomienie push o zdalnym odblokowaniu z aplikacji — przydatne
          // gdy w przyszłości konto będzie mieć więcej niż jednego administratora,
          // oraz jako potwierdzenie/log aktywności dla samego właściciela.
          dbPool.query('SELECT push_token, push_entries FROM accounts WHERE id = $1', [accountId])
            .then((r) => {
              if (r.rows.length > 0 && r.rows[0].push_token && r.rows[0].push_entries !== false) {
                sendPushNotification(r.rows[0].push_token, "Drzwi odblokowane", "Zdalne odblokowanie z aplikacji mobilnej.");
              }
            })
            .catch(() => {});

          // Bezpiecznik: jeśli sprzęt jest offline i nigdy nie odpowie, kolejka
          // nie powinna zostać aktywna w nieskończoność.
          setTimeout(() => {
            unlockQueues[targetMac] = false;
          }, 8000);
        }
        return sendJSON(res, 200, { status: "ok" });
      }

      // =========================================================================
      // WŁĄCZENIE TRYBU UCZENIA CZYTNIKA RFID
      // =========================================================================
      if (pathname === '/api/toggle_learn' && req.method === 'GET') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const devRes = await resolveTargetDevice(accountId, query.mac, 'mac_address, operational_mode');
        if (devRes.rows.length > 0) {
          const targetMac = devRes.rows[0].mac_address;
          const nextMode = devRes.rows[0].operational_mode === 'Czuwanie' ? 'Uczenie' : 'Czuwanie';
          // Limit kart wg pakietu właściciela — sprawdzamy PRZED wejściem w Uczenie,
          // żeby nadmiarowa karta nie została w ogóle zeskanowana. Wyłączanie trybu
          // (Uczenie→Czuwanie) zawsze przechodzi.
          if (nextMode === 'Uczenie') {
            const clEnt = await deviceOwnerEntitlements(targetMac);
            const cc = await dbPool.query('SELECT COUNT(*) FROM card_credentials WHERE mac_address = $1', [targetMac]);
            if (parseInt(cc.rows[0].count) >= clEnt.max_cards)
              return sendJSON(res, 403, {
                error: `Limit kart (${clEnt.max_cards}) osiągnięty w pakiecie ${clEnt.license_tier}. Zwiększ pakiet, aby dodać więcej.`,
                limit: clEnt.max_cards, used: parseInt(cc.rows[0].count), tier: clEnt.license_tier, feature: 'max_cards'
              });
          }
          await dbPool.query('UPDATE devices SET operational_mode = $1 WHERE mac_address = $2', [nextMode, targetMac]);
          if (nextMode === 'Uczenie') {
            // url.parse już zdekodował parametr (ponowny decodeURIComponent rzucał na '%').
            // Bez cudzysłowów i ukośników — firmware wycina nazwę z odpowiedzi prostym parserem.
            const learnName = truncateUtf8(String(query.username || '').replace(/["\\\u0000-\u001f]/g, '').trim(), 15);
            learningQueues[targetMac] = learnName || 'Nowy Użytkownik';
          } else {
            delete learningQueues[targetMac];
          }
          writeToLocalLogFile('API Control Command', `[Node: ${targetMac}] Operational mode set to: ${nextMode}.`);
        }
        return sendJSON(res, 200, { status: "ok" });
      }

      // =========================================================================
      // LOGOWANIE NACIŚNIĘCIA FIZYCZNEGO PRZYCISKU
      // =========================================================================
      if (pathname === '/api/hardware/log_button' && req.method === 'GET') {
        const btnAuth = await authenticateDevice(req, query.mac);
        if (!btnAuth.ok) {
          logDeviceAuthFailure(btnAuth, query.mac, pathname, cleanIp);
          return sendJSON(res, 401, { error: 'device_auth_failed' });
        }
        const targetMac = btnAuth.mac;

        await dbPool.query('INSERT INTO system_events (mac_address, message, category) VALUES ($1, $2, $3)', [targetMac, 'Naciśnięto przycisk fizyczny', 'entries']);
        writeToLocalLogFile('Hardware Handshake', `[Node: ${targetMac}] Local physical click recorded quietly.`);

        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end("OK");
        return;
      }

      //  UPDATE -- OTA CHECK
      if (pathname === '/api/hardware/log' && req.method === 'GET') {
        // Dziennik widoczny w aplikacji — przyjmujemy wpisy wyłącznie od uwierzytelnionej
        // centralki (wcześniej każdy znający MAC mógł dopisać dowolny tekst), z limitem długości.
        const logAuth = await authenticateDevice(req, query.mac);
        if (!logAuth.ok) {
          logDeviceAuthFailure(logAuth, query.mac, pathname, cleanIp);
          return sendJSON(res, 401, { error: 'device_auth_failed' });
        }
        const msg = String(query.msg || '').trim().slice(0, 500);
        const eventMac = logAuth.mac;
        // Pełny, techniczny komunikat (rozmiar pliku, nagłówki, transmisja blokowa
        // itd.) zawsze trafia do pliku logów na dysku — do debugowania.
        writeToLocalLogFile('Hardware Remote Log', `[Node: ${eventMac}] ${msg}`);

        // Do bazy widocznej w aplikacji klienta trafiają TYLKO uproszczone,
        // nietechniczne wersje komunikatów aktualizacji (bez słowa "OTA",
        // bez rozmiaru pliku, bez szczegółów transmisji). Pośrednie etapy
        // (nagłówki przeczytane, zakończono pobieranie) są celowo pomijane —
        // klient widzi tylko 3 wpisy na cały cykl: start, w trakcie, sukces/błąd.
        let clientMessage = null;
        if (/\[OTA PULL\] Proba polaczenia/i.test(msg)) {
          clientMessage = 'Próba nawiązania połączenia z serwerem w celu pobrania aktualizacji.';
        } else if (/\[OTA PULL\] Start szybkiej transmisji/i.test(msg)) {
          clientMessage = 'Aktualizacja w toku (wgrywanie pliku)...';
        } else if (/\[OTA PULL SUCCESS\]/i.test(msg)) {
          clientMessage = 'Aktualizacja zakończona pomyślnie ✅';
        } else if (/\[OTA PULL ERR\]/i.test(msg)) {
          clientMessage = 'Aktualizacja nie powiodła się. Spróbuj ponownie.';
        } else if (!/\[OTA/i.test(msg)) {
          // Komunikat spoza rodziny OTA (inna telemetria) — zapisujemy bez zmian.
          clientMessage = msg;
        }
        // Pośrednie etapy OTA ("Naglowki przeczytane", "Zakonczono pobieranie")
        // mają clientMessage === null i celowo NIE trafiają do system_events.

        if (clientMessage) {
          await dbPool.query(
            'INSERT INTO system_events (mac_address, message, category) VALUES ($1, $2, $3)',
            [eventMac, clientMessage, 'connections']
          ).catch(() => {});
        }
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end("OK");
        return;
      }

      // UPDATE LOGIC -- CHECK NEW PACKAGES

      if (pathname === '/api/firmware/version' && req.method === 'GET') {
        // Publiczne, ale z pamięcią podręczną: wcześniej KAŻDE wywołanie szło do GitHuba
        // z tokenem, więc zalewając ten adres dało się wyczerpać limit API i zablokować OTA.
        const fresh = firmwareVersionCache.value && (Date.now() - firmwareVersionCache.at) < 5 * 60 * 1000;
        if (!fresh) {
          try {
            if (!firmwareVersionCache.inflight) {
              firmwareVersionCache.inflight = githubJson(`/repos/${GITHUB_USER}/${GITHUB_REPO}/releases/latest`)
                .finally(() => { firmwareVersionCache.inflight = null; });
            }
            const release = await firmwareVersionCache.inflight;
            latestFirmwareVersion = release.tag_name;
            latestFirmwareReleaseId = release.id;
            firmwareVersionCache.value = { latestVersion: release.tag_name, releaseId: release.id };
            firmwareVersionCache.at = Date.now();
          } catch (e) {
            writeToLocalLogFile('DEBUG GITHUB', `Sprawdzenie wersji nieudane: ${e.message}`);
            if (!firmwareVersionCache.value) return sendJSON(res, 502, { error: 'Nie udało się sprawdzić wersji oprogramowania.' });
          }
        }
        return sendJSON(res, 200, firmwareVersionCache.value);
      }

    // UPDATE LOGIC -- GET NEW PACKAGE

    // Wymaga zalogowania (wcześniej każdy mógł jednym żądaniem wymusić aktualizację
    // WSZYSTKICH centralek) i uzbraja OTA tylko dla centralek, do których konto ma dostęp.
    // Wydanie MUSI mieć podpis ECDSA (<plik>.bin.sig) — bezpieczny firmware odrzuca obraz
    // bez poprawnego podpisu (README §7.5), więc niepodpisanego w ogóle nie rozsyłamy.
    if (pathname === '/api/ota/push' && (req.method === 'POST' || req.method === 'GET')) {
      const accountId = await requireAuth(req, res); if (!accountId) return;
      const logFile = '/var/log/smartlock/smartlock_system.log';
      const forceLog = (msg) => {
        try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] [DEBUG OTA PUSH] ${msg}\n`); } catch (e) {}
      };

      const wantedMac = normalizeMac(body.mac || query.mac);
      const targets = await dbPool.query(
        `SELECT d.mac_address FROM devices d WHERE ${DEVICE_ACCESS_CONDITION}` + (wantedMac ? ' AND d.mac_address = $2' : ''),
        wantedMac ? [accountId, wantedMac] : [accountId]);
      if (targets.rows.length === 0) return sendJSON(res, 404, { error: 'Brak centralki do aktualizacji.' });
      const targetMacs = targets.rows.map(r => r.mac_address);

      try {
        forceLog(`Żądanie OTA od konta ${accountId} dla: ${targetMacs.join(', ')}`);
        const release = await githubJson(`/repos/${GITHUB_USER}/${GITHUB_REPO}/releases/latest`);
        const assets = release.assets || [];
        const binAsset = assets.find(a => a.name.endsWith('.bin') && !a.name.includes('merged'));
        if (!binAsset) return sendJSON(res, 404, { error: 'Brak właściwego pliku .bin w wydaniu.' });
        const sigAsset = assets.find(a => a.name === binAsset.name + '.sig');
        if (!sigAsset) {
          forceLog(`Wydanie ${release.tag_name} nie ma podpisu ${binAsset.name}.sig — OTA wstrzymana.`);
          return sendJSON(res, 409, { error: 'Najnowsze wydanie nie jest podpisane — aktualizacja wstrzymana.' });
        }

        const safeName = path.basename(binAsset.name);
        const binPath = path.join(updatesDir, safeName);
        const sigPath = binPath + '.sig';
        if (!fs.existsSync(updatesDir)) fs.mkdirSync(updatesDir, { recursive: true });
        if (!(fs.existsSync(binPath) && fs.statSync(binPath).size > 0)) {
          forceLog(`Pobieram ${safeName}...`);
          await downloadGithubAsset(binAsset.id, binPath);
        }
        if (!(fs.existsSync(sigPath) && fs.statSync(sigPath).size > 0)) {
          await downloadGithubAsset(sigAsset.id, sigPath);
        }

        latestFirmwareFile = safeName;
        latestFirmwareVersion = release.tag_name;
        latestFirmwareReleaseId = release.id;
        for (const m of targetMacs) otaPendingDevices[m] = Date.now();
        forceLog(`OTA uzbrojona: ${safeName} (release ${release.id}) dla ${targetMacs.length} centralek.`);
        return sendJSON(res, 200, { success: true, devices: targetMacs.length });
      } catch (e) {
        forceLog(`Błąd przygotowania OTA: ${e.message}`);
        return sendJSON(res, 502, { error: 'Nie udało się pobrać aktualizacji z GitHub.' });
      }
    }
      // Return .bin file

      if (pathname === '/api/lock/download-firmware' && req.method === 'GET') {
        const logFile = '/var/log/smartlock/smartlock_system.log';
        const forceLog = (msg) => {
          try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] [DEBUG LOCK DOWNLOAD] ${msg}\n`); } catch (e) {}
        };

        // Obraz firmware dostaje wyłącznie uwierzytelniona centralka z uzbrojoną OTA
        // (wcześniej plik mógł pobrać każdy — łącznie z wszytymi w niego sekretami).
        const dlAuth = await authenticateDevice(req, query.mac);
        if (!dlAuth.ok) {
          logDeviceAuthFailure(dlAuth, query.mac, pathname, cleanIp);
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          return res.end('device auth failed');
        }
        const mac = dlAuth.mac;
        if (!latestFirmwareFile || !otaPendingDevices[mac]) {
          forceLog(`Zamek [${mac}] chciał pobrać firmware, ale nie ma dla niego uzbrojonej aktualizacji.`);
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end("Brak aktywnej aktualizacji dla tej centralki.");
        }

        const filePath = path.join(updatesDir, latestFirmwareFile);
        const sigPath = filePath + '.sig';
        if (!fs.existsSync(filePath) || !fs.existsSync(sigPath)) {
          forceLog(`Krytyczny błąd: brak ${latestFirmwareFile} lub jego podpisu na dysku serwera!`);
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end("Plik nie istnieje na dysku.");
        }

        const fileSize = fs.statSync(filePath).size;
        // Podpis ECDSA (DER) obrazu — firmware liczy SHA-256 w trakcie zapisu i odrzuca
        // aktualizację, jeśli podpis nie pasuje do klucza publicznego wszytego w firmware.
        const signatureB64 = fs.readFileSync(sigPath).toString('base64');
        forceLog(`Zamek [${mac}] pobiera ${latestFirmwareFile} (${fileSize} B).`);

        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileSize,
          'X-Firmware-Signature': signatureB64,
        });

        const readStream = fs.createReadStream(filePath);
        let transmittedBytes = 0;
        actualLockStates[mac] = { ...(actualLockStates[mac] || {}), otaProgress: 0, timestamp: Date.now() };

        readStream.on('data', (chunk) => {
          transmittedBytes += chunk.length;
          const currentPercentage = Math.min(98, Math.round((transmittedBytes / fileSize) * 100));
          // Odświeżamy "timestamp", żeby urządzenie nie pokazało się jako offline
          // w trakcie długiego transferu (w tym czasie nie pollinguje).
          actualLockStates[mac] = { ...(actualLockStates[mac] || {}), otaProgress: currentPercentage, timestamp: Date.now() };
        });
        readStream.pipe(res);
        readStream.on('end', () => {
          delete otaPendingDevices[mac];
          actualLockStates[mac] = { ...(actualLockStates[mac] || {}), otaProgress: 99, timestamp: Date.now() };
          forceLog(`Strumieniowanie ${latestFirmwareFile} do zamka [${mac}] zakończone.`);
        });
        readStream.on('error', (err) => {
          delete otaPendingDevices[mac];
          forceLog(`Błąd podczas przesyłania pliku do zamka [${mac}]: ${err.message}`);
        });
        return;
      }

      // /api/device/provision USUNIĘTY: bez żadnego uwierzytelnienia przypinał dowolny MAC
      // do dowolnego ownerId (przejęcie centralki przed jej pierwszą rejestracją), a firmware
      // nigdy go nie używał. Centralki rejestrują się wyłącznie w pollu (klucz urządzenia).
      if (pathname === '/api/device/provision') {
        return sendJSON(res, 410, { error: 'Endpoint usunięty.' });
      }

      // =========================================================================
      // LOOP POLL ZAMKA
      // =========================================================================
      // =========================================================================
      // ANTI-TAMPER ALERT  — called by firmware, NOT the app (no JWT needed)
      // Firmware POSTs {mac, active:true/false} when the NC tamper switch
      // inside the second-board enclosure opens or closes.
      // =========================================================================
      if (pathname === '/api/tamper' && req.method === 'POST') {
        // Fałszywe alarmy sabotażu (spam push, aż właściciel wyłączy alarmy) były
        // możliwe dla każdego znającego MAC — teraz tylko uwierzytelniona centralka.
        const tamperAuth = await authenticateDevice(req, body.mac);
        if (!tamperAuth.ok) {
          logDeviceAuthFailure(tamperAuth, body.mac, pathname, cleanIp);
          return sendJSON(res, 401, { error: 'device_auth_failed' });
        }
        const mac = tamperAuth.mac;
        const active = !!body.active;

        const severity  = active ? '⚠️  TAMPER ALERT' : '✅ Tamper Cleared';
        const detail    = active
          ? 'Obudowa drugiej płytki (panel RFID) została OTWARTA. Możliwy sabotaż!'
          : 'Obudowa drugiej płytki została ponownie zamknięta.';

        writeToLocalLogFile('TAMPER', `[Node: ${mac}] ${severity}: ${detail}`);

        // Log to database as a system event (appears in app logs)
        try {
          await dbPool.query(
            'INSERT INTO system_events (mac_address, message, category) VALUES ($1, $2, $3)',
            [mac, `${severity}: ${detail}`, 'security']
          );
        } catch (_) {}

        // Push notification to account owner
        try {
          const accRes = await dbPool.query(
            `SELECT a.push_token, a.push_alarms
             FROM accounts a
             JOIN devices d ON d.account_id = a.id
             WHERE d.mac_address = $1 LIMIT 1`,
            [mac]
          );
          if (accRes.rows.length > 0) {
            const { push_token, push_alarms } = accRes.rows[0];
            if (push_token && push_token !== 'LOGGED_OUT' && push_alarms !== false) {
              sendPushNotification(push_token, severity, detail);
            }
          }
        } catch (_) {}

        return sendJSON(res, 200, { status: 'logged' });
      }

      if ((pathname === '/api/hardware/poll' || pathname === '/api/poll' || pathname === '/poll') && req.method === 'GET') {
        const logFile = '/var/log/smartlock/smartlock_system.log';
        const forceLog = (msg) => {
          try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] [DEBUG HARDWARE POLL] ${msg}\n`); } catch (e) {}
        };

        const rawMac = normalizeMac(query.mac);
        if (!rawMac) return sendJSON(res, 400, { error: 'Missing or invalid mac' });
        const reversedRawMac = rawMac.split(':').reverse().join(':');

        // Poll NIE jest logowany cyklicznie (był ślad co 60 s — 1440 linii/dzień na centralkę,
        // z e-mailem właściciela w każdej). Logujemy wyłącznie ZMIANY STANU — patrz notePollSeen()
        // niżej: pierwszy poll po starcie, powrót po ciszy, zmiana firmware, utrata łączności.
        // „Czy centralka odpytuje?" odpowiada devices.last_heartbeat.

        // DEREGISTRACJA (okno 120 s): wiersza centralki już nie ma, więc klucz sprawdzamy
        // względem hasha zapamiętanego w chwili odłączenia (scheduleDeviceWipe). Dopóki
        // okno trwa, centralka NIE może się też ponownie zarejestrować.
        const wipeKey = deregisterQueues[rawMac] ? rawMac : (deregisterQueues[reversedRawMac] ? reversedRawMac : null);
        if (wipeKey) {
          const wipe = deregisterQueues[wipeKey];
          if (Date.now() < wipe.until) {
            const key = readDeviceKey(req);
            const keyOk = wipe.keyHash ? (!!key && hashDeviceKey(key) === wipe.keyHash) : (!!key || LEGACY_DEVICE_AUTH);
            if (!keyOk) {
              logDeviceAuthFailure({ reason: 'bad_key_wipe' }, rawMac, pathname, cleanIp);
              return sendJSON(res, 401, { error: 'device_auth_failed' });
            }
            return sendJSON(res, 200, { unlock: false, learn: false, ota: false, deregister: true });
          }
          delete deregisterQueues[wipeKey];
        }

        let auth = await authenticateDevice(req, rawMac);

        // REJESTRACJA NOWEJ CENTRALKI: nieznany MAC + e-mail właściciela z konfiguracji.
        if (!auth.ok && auth.reason === 'unknown_device') {
          const email = String(query.email || '').trim().toLowerCase();
          const key = readDeviceKey(req);
          const skipLog = (why) => {
            if (!provisionSkipLog[rawMac] || Date.now() - provisionSkipLog[rawMac] > 60000) {
              provisionSkipLog[rawMac] = Date.now();
              writeToLocalLogFile('Provisioning', `[Node: ${rawMac}] NIE zarejestrowano: ${why}`);
            }
          };
          if (!email) {
            skipLog('brak e-maila w pollu.');
            return sendJSON(res, 200, { unlock: false, learn: false, ota: false, deregister: false });
          }
          if (!key && !LEGACY_DEVICE_AUTH) {
            skipLog('brak klucza urządzenia (stary firmware, LEGACY_DEVICE_AUTH=off).');
            return sendJSON(res, 401, { error: 'device_auth_failed' });
          }
          const accountRes = await dbPool.query('SELECT id, email_verified FROM accounts WHERE email = $1', [email]);
          if (accountRes.rows.length === 0 || accountRes.rows[0].email_verified === false) {
            skipLog(`e-mail '${email.slice(0, 80)}' nie pasuje do żadnego ZWERYFIKOWANEGO konta. Załóż i zweryfikuj konto najpierw.`);
            return sendJSON(res, 200, { unlock: false, learn: false, ota: false, deregister: false });
          }
          // Klucz przypinamy przy rejestracji — od tej chwili ten MAC obsłuży wyłącznie
          // urządzenie, które go zna. ON CONFLICT: dwa równoległe polle nie zdublują wiersza.
          // last_known_ip jest tylko informacyjne (serwer nigdy się pod nie nie łączy), ale
          // kolumna istnieje od zawsze i MUSI być podana — bez niej INSERT potrafi paść na
          // NOT NULL, a poll kończył się cichym 500 i centralka nigdy się nie rejestrowała.
          const regIpStr = String(query.ip || '').trim();
          const regIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(regIpStr) ? regIpStr : cleanIp;
          let ins;
          try {
            ins = await dbPool.query(
              `INSERT INTO devices (mac_address, account_id, last_known_ip, firmware_version, operational_mode, device_key_hash)
               VALUES ($1, $2, $3, $4, 'Czuwanie', $5)
               ON CONFLICT (mac_address) DO NOTHING RETURNING mac_address`,
              [rawMac, accountRes.rows[0].id, regIp, String(query.version || 'v2.9.6').slice(0, 32), key ? hashDeviceKey(key) : null]);
          } catch (e) {
            // Prawdziwy powód do logu — wcześniej lądował tylko w CORE PANIC jako ogólny 500.
            writeToLocalLogFile('Provisioning', `[Node: ${rawMac}] BŁĄD rejestracji w bazie: ${e.message}`);
            return sendJSON(res, 500, { error: 'registration_failed' });
          }
          if (ins.rows.length > 0) {
            writeToLocalLogFile('Provisioning', `[Node: ${rawMac}] Pomyślnie utworzono i przypisano centralkę do konta: ${email}${key ? '' : ' (BEZ klucza — stary firmware)'}`);
            mailTransport.sendMail({
              from: '"CTRLABLE Node System" <node@ctrlable.pl>',
              to: email,
              subject: 'Nowa centralka dodana do Twojego konta CTRLABLE',
              html: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
                  <h2>Centralka została dodana ✓</h2>
                  <p>Nowa centralka CTRLABLE Node właśnie zgłosiła się i została przypisana do Twojego konta.</p>
                  <p style="font-family:monospace; color:#0284c7;">MAC: ${rawMac}</p>
                  <p>Możesz nią teraz zarządzać w aplikacji — dodać karty RFID i kody PIN. Jeśli to nie Ty dodawałeś urządzenie, skontaktuj się z nami.</p>
                  <br>
                  <p>Pozdrawiamy,<br><strong>Zespół CTRLABLE</strong></p>
                </div>`
            }, (err) => { if (err) writeToLocalLogFile('DeviceAdded SMTP Fail', err.message); });
          }
          auth = await authenticateDevice(req, rawMac);
        }

        if (!auth.ok) {
          logDeviceAuthFailure(auth, rawMac, pathname, cleanIp);
          return sendJSON(res, 401, { error: 'device_auth_failed' });
        }
        const mac = auth.mac;

        // Centralka zgłasza e-mail INNEGO konta niż jej właściciel w bazie: to nie jest
        // rejestracja (MAC już istnieje) — urządzenie zostaje przy dotychczasowym koncie.
        // Najczęstsza przyczyna „dodałem centralkę, a nie ma jej na koncie" po ponownej
        // konfiguracji: trzeba ją najpierw wyrejestrować ze starego konta (§6.11). Log co 60 s.
        if (query.email && auth.device && auth.device.account_id) {
          const _ok = `owner:${mac}`;
          if (!provisionSkipLog[_ok] || Date.now() - provisionSkipLog[_ok] > 60000) {
            provisionSkipLog[_ok] = Date.now();
            const own = await dbPool.query('SELECT email FROM accounts WHERE id = $1', [auth.device.account_id]).catch(() => ({ rows: [] }));
            const reported = String(query.email).trim().toLowerCase();
            if (own.rows.length && own.rows[0].email.toLowerCase() !== reported) {
              writeToLocalLogFile('Provisioning', `[Node: ${mac}] Centralka zgłasza e-mail '${reported.slice(0, 80)}', ale jest zarejestrowana na konto ${auth.device.account_id} (${own.rows[0].email}). NIE przepinam — wyrejestruj ją ze starego konta (Ustawienia → Strefa zaawansowana), potem skonfiguruj ponownie.`);
            }
          }
        }

        // Heartbeat + wersja. Adres IP zapisujemy wyłącznie informacyjnie i tylko prywatny
        // IPv4 — serwer NIGDY się pod niego nie łączy (dawniej: HTTP z hasłem na port 80,
        // a podrobione ip= kierowało te żądania pod dowolny adres).
        const ipStr = String(query.ip || '').trim();
        const reportedIp = (/^\d{1,3}(\.\d{1,3}){3}$/.test(ipStr) && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ipStr)) ? ipStr : null;
        const clientReportedVersion = query.version ? String(query.version).slice(0, 32) : null;
        let currentHardwareVersion = '0.0.0';
        const devLookup = await dbPool.query(
          `UPDATE devices SET last_heartbeat = CURRENT_TIMESTAMP,
                  last_known_ip = COALESCE($1, last_known_ip),
                  firmware_version = COALESCE($3, firmware_version)
            WHERE mac_address = $2 RETURNING firmware_version, auto_lock_delay_ms`,
          [reportedIp, mac, clientReportedVersion]);
        if (devLookup.rows.length > 0) currentHardwareVersion = devLookup.rows[0].firmware_version || '0.0.0';
        notePollSeen(mac, clientReportedVersion || currentHardwareVersion, !!auth.legacy);

        // 🌟 PRAWDA SPRZĘTOWA: centralka w KAŻDYM pollu zgłasza realny stan przekaźnika
        // ("opened"). To JEDYNE miejsce, gdzie ustawiamy actualLockStates[mac].state.
        // Sanityzacja release_id: po wyczyszczeniu EEPROM (0xFF) urządzenie zgłasza
        // 4294967295 — traktujemy to jako "nieznane" (0), inaczej OTA nigdy by się nie proponowała.
        let deviceReleaseId = parseInt(query.release_id || '0', 10);
        if (!Number.isFinite(deviceReleaseId) || deviceReleaseId > 4000000000) deviceReleaseId = 0;
        if (query.opened !== undefined) {
          const reportedOpen = query.opened === '1';
          actualLockStates[mac] = {
            ...(actualLockStates[mac] || {}),
            state: reportedOpen,
            timestamp: Date.now(),
            deviceReleaseId: deviceReleaseId || (() => {
              const prev = actualLockStates[mac]?.deviceReleaseId || 0;
              return prev > 4000000000 ? 0 : prev;
            })()
          };
          if (reportedOpen) delete pendingUnlocks[mac];
        } else {
          actualLockStates[mac] = { state: false, ...(actualLockStates[mac] || {}), timestamp: Date.now() };
        }

        if ((actualLockStates[mac]?.otaProgress || 0) === 99) {
          actualLockStates[mac] = { ...(actualLockStates[mac] || {}), otaProgress: 100 };
        }

        // Komenda otwarcia — wyłącznie dla TEJ centralki (bez kolejki „wieloznacznej").
        const unlockAction = !!unlockQueues[mac];
        if (unlockAction) unlockQueues[mac] = false;
        const isLearning = !!learningQueues[mac];

        // KOLEJKA KOMEND: potwierdzenie wykonanych (ack) i kolejna porcja do wykonania.
        // Stary firmware (bez klucza) komend nie rozumie — nie wysyłamy mu ich, zostają
        // w kolejce do czasu aktualizacji (aplikacja pokazuje je jako oczekujące).
        const ackId = parseInt(query.ack || '0', 10);
        if (Number.isFinite(ackId) && ackId > 0) {
          await dbPool.query(
            'UPDATE device_commands SET acked_at = NOW() WHERE mac_address = $1 AND id <= $2 AND acked_at IS NULL',
            [mac, ackId]);
        }
        let cmdBatch = '';
        if (!auth.legacy) {
          const pend = await dbPool.query(
            'SELECT id, cmd FROM device_commands WHERE mac_address = $1 AND acked_at IS NULL ORDER BY id ASC LIMIT $2',
            [mac, DEVICE_CMD_BATCH]);
          if (pend.rows.length > 0) {
            cmdBatch = pend.rows.map(r => `${r.id}:${r.cmd}`).join(';');
            await dbPool.query('UPDATE device_commands SET delivered_at = COALESCE(delivered_at, NOW()) WHERE id = ANY($1)',
              [pend.rows.map(r => r.id)]);
          }
        }

        // OTA: tylko gdy właściciel/współadmin uzbroił aktualizację DLA TEJ centralki
        // i serwer ma nowsze wydanie niż zgłoszone przez urządzenie.
        const latestFw = getLatestFirmwareContext();
        const otaUpdateTrigger = (
          latestFirmwareReleaseId > 0 &&
          latestFirmwareReleaseId > deviceReleaseId &&
          !!otaPendingDevices[mac]
        );
        if (otaUpdateTrigger) {
          forceLog(`[OTA ACTIVATED] Zezwolono urządzeniu [${mac}] na pobranie wydania ${latestFirmwareReleaseId} (ma ${deviceReleaseId}, wersja ${currentHardwareVersion}).`);
        }

        // Czas otwarcia rygla ustawiony przez właściciela (per centralka).
        const autoLockDelayMs = devLookup.rows.length > 0 ? devLookup.rows[0].auto_lock_delay_ms : null;

        return sendJSON(res, 200, {
          unlock: unlockAction,
          learn: isLearning,
          username: learningQueues[mac] || '',
          ota: otaUpdateTrigger,
          deregister: false,
          latest_release_id: latestFirmwareReleaseId,
          latest_version: latestFw.version,
          cmds: cmdBatch,
          ...(autoLockDelayMs ? { auto_lock_delay: autoLockDelayMs } : {})
        });
      }

      // =========================================================================
      // ODBIERANIE STRUMIENIA TELEMETRII Z ZAMKA
      // =========================================================================
      if ((pathname === '/api/log' || pathname === '/log') && req.method === 'POST') {
        // Usunięty: bez uwierzytelnienia, a centralkę wybierał po adresie IP źródła — za
        // proxy to zawsze adres proxy. Firmware loguje przez /api/hardware/log (z kluczem).
        return sendJSON(res, 410, { error: 'Endpoint usunięty.' });
      }

      // =========================================================================
      // SPRAWDZANIE WŁAŚCIWOŚCI PERYFERJÓW
      // =========================================================================
      if ((pathname === '/api/hardware/scan' || pathname === '/api/scan' || pathname === '/scan') && req.method === 'POST') {
        // Raport skanu (log + push). Bez uwierzytelnienia służył jako wyrocznia UID
        // i pozwalał wstawiać do dziennika fałszywe „Otwarto: <imię>".
        const scanAuth = await authenticateDevice(req, body.mac);
        if (!scanAuth.ok) {
          logDeviceAuthFailure(scanAuth, body.mac, pathname, cleanIp);
          return sendJSON(res, 401, { error: 'device_auth_failed' });
        }
        const mac = scanAuth.mac;
        const uid = String(body.uid || '').toUpperCase();
        if (!/^[0-9A-F]{2}( [0-9A-F]{2}){3,9}$/.test(uid)) return sendJSON(res, 400, { error: 'Invalid uid' });
        const credentialRes = await dbPool.query(
          `SELECT holder_name, is_active, schedule_enabled, schedule_days, schedule_start_minutes, schedule_end_minutes
           FROM card_credentials WHERE mac_address = $1 AND card_uid = $2`, [mac, uid]);

        let scheduleBlocked = false;
        if (credentialRes.rows.length > 0 && credentialRes.rows[0].is_active && credentialRes.rows[0].schedule_enabled) {
          const nowDate = new Date();
          const nowDayBit = 1 << nowDate.getDay();
          const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();
          const c = credentialRes.rows[0];
          const dayOk = (c.schedule_days & nowDayBit) !== 0;
          const timeOk = nowMinutes >= c.schedule_start_minutes && nowMinutes < c.schedule_end_minutes;
          if (!dayOk || !timeOk) scheduleBlocked = true;
        }

        if (credentialRes.rows.length > 0 && credentialRes.rows[0].is_active && !scheduleBlocked) {
          // NIE kolejkujemy tu otwarcia! Centralka podjęła decyzję LOKALNIE i już
          // otworzyła rygiel — `unlockQueues[mac] = true` powodowało, że przy najbliższym
          // pollu dostawała `unlock:true` i otwierała DRUGI RAZ, sekundę po zamknięciu.
          // Dodatkowo omijało to lokalny harmonogram (zdalne otwarcie go nie sprawdza).
          // Ten endpoint jest wyłącznie RAPORTEM (log + push) — zgodnie z §5.7 README.
          await dbPool.query('INSERT INTO system_events (mac_address, message, category) VALUES ($1, $2, $3)', [mac, `Otwarto: ${credentialRes.rows[0].holder_name}`, 'entries']);
          writeToLocalLogFile('Access Granted', `[Node: ${mac}] Matched name description: ${credentialRes.rows[0].holder_name}`);

          // SILNIK POWIADOMIEŃ PUSH: Sprawdzanie tokenu push i ustawień powiadomień dla właściciela konta
          let targetMacForOwner = mac;
          let ownerRes = await dbPool.query('SELECT account_id FROM devices WHERE mac_address = $1 LIMIT 1', [targetMacForOwner]);

          // Jeśli nie znaleziono urządzenia, próbujemy odwrócić bajty MAC (tak jak w poll)
          if (ownerRes.rows.length === 0 && mac.includes(':')) {
            const reversedMac = mac.split(':').reverse().join(':');
            const ownerResRev = await dbPool.query('SELECT account_id FROM devices WHERE mac_address = $1 LIMIT 1', [reversedMac]);
            if (ownerResRev.rows.length > 0) {
              targetMacForOwner = reversedMac;
              ownerRes = ownerResRev;
            }
          }

          if (ownerRes.rows.length > 0) {
            const ownerId = ownerRes.rows[0].account_id;
            const tokenRes = await dbPool.query('SELECT push_token, push_entries FROM accounts WHERE id = $1', [ownerId]);

            if (tokenRes.rows.length === 0) {
              writeToLocalLogFile('Push Diagnostic', `Błąd: Urządzenie istnieje, ale konto właściciela ID: ${ownerId} nie istnieje w tabeli accounts.`);
            } else {
              const accountData = tokenRes.rows[0];

              if (!accountData.push_token) {
                writeToLocalLogFile('Push Diagnostic', `⚠️ Brak zapisanego tokenu push dla konta ID: ${ownerId}. Zaloguj się ponownie w aplikacji.`);
              } else if (accountData.push_entries === false) {
                writeToLocalLogFile('Push Diagnostic', `🔇 Powiadomienia o wejściach są wyłączone suwakiem dla konta ID: ${ownerId}.`);
              } else {
                // Wszystkie warunki spełnione -> Wywołujemy wysyłkę
                sendPushNotification(
                  accountData.push_token,
                  "Ktoś wszedł do domu",
                  `Użytkownik ${credentialRes.rows[0].holder_name} właśnie otworzył drzwi.`
                );
              }
            }
          } else {
            writeToLocalLogFile('Push Diagnostic', `[Node: ${mac}] ⚠️ Pomięto push: adres MAC nie jest przypisany do żadnego konta w tabeli devices.`);
          }

          return sendJSON(res, 200, { access: "granted" });
        } else {
          const nameLabel = credentialRes.rows.length > 0 ? credentialRes.rows[0].holder_name : 'Nieznany';
          const reason = scheduleBlocked ? 'poza harmonogramem' : 'niezgodny podpis karty';
          await dbPool.query('INSERT INTO system_events (mac_address, message, category) VALUES ($1, $2, $3)', [mac, `Odmowa: ${nameLabel} [${uid}] (${reason})`, 'security']);
          writeToLocalLogFile('Access Denied', `[Node: ${mac}] ${scheduleBlocked ? 'Outside schedule window' : 'Mismatch signature vector'}: ${uid}`);
          return sendJSON(res, 200, { access: "denied", reason: scheduleBlocked ? 'outside_schedule' : 'no_match' });
        }
      }

      // =========================================================================
      // MAPOWANIE NOWEJ KARTY ZE SLOTEM DO BAZY
      // =========================================================================
      if ((pathname === '/api/hardware/register' || pathname === '/api/register' || pathname === '/register') && req.method === 'POST') {
        // Zapis nowej karty do bazy — tylko od uwierzytelnionej centralki. Wcześniej każdy
        // znający MAC mógł dopisać kartę albo przestawić slot istniejącej, przez co blokada
        // w aplikacji trafiała potem w niewłaściwą kartę.
        const regAuth = await authenticateDevice(req, body.mac);
        if (!regAuth.ok) {
          logDeviceAuthFailure(regAuth, body.mac, pathname, cleanIp);
          return sendJSON(res, 401, { error: 'device_auth_failed' });
        }
        const mac = regAuth.mac;
        const uid = String(body.uid || '').toUpperCase();
        if (!/^[0-9A-F]{2}( [0-9A-F]{2}){3,9}$/.test(uid)) return sendJSON(res, 400, { error: 'Invalid uid' });
        const slotNum = parseInt(body.slot, 10);
        const slot = Number.isFinite(slotNum) && slotNum >= 0 && slotNum < 1000 ? slotNum : 0;
        const pendingLabel = learningQueues[mac] || 'Nowy Użytkownik';

        await dbPool.query(
          'INSERT INTO card_credentials (mac_address, card_uid, holder_name, is_active, hardware_slot_idx) VALUES ($1, $2, $3, true, $4) ON CONFLICT (mac_address, card_uid) DO UPDATE SET holder_name = $3, hardware_slot_idx = $4',
          [mac, uid, pendingLabel, slot]
        );

        await dbPool.query('INSERT INTO system_events (mac_address, message, category) VALUES ($1, $2, $3)', [mac, `Przypisano: ${pendingLabel} [${uid}]`, 'provisioning']);
        writeToLocalLogFile('Hardware Registration', `[Node: ${mac}] Mapped card holder row to: ${pendingLabel} [${uid}] (EEPROM Slot: ${slot})`);
        delete learningQueues[mac];
        return sendJSON(res, 200, { status: "registered" });
      }
      // =========================================================================
      // RAPORT DIAGNOSTYCZNY / SELF-TEST Z CENTRALKI — POST JSON, klucz urządzenia.
      // kind: 0 = self-test klienta (bez kart), 1 = diagnostyka serwisowa (z kartami),
      // 2 = jak 1 + wynik testu przekaźnika. Trzymamy 5 ostatnich raportów per centralka.
      // =========================================================================
      if (pathname === '/api/hardware/diag' && req.method === 'POST') {
        const diagAuth = await authenticateDevice(req, body.mac);
        if (!diagAuth.ok) {
          logDeviceAuthFailure(diagAuth, body.mac, pathname, cleanIp);
          return sendJSON(res, 401, { error: 'device_auth_failed' });
        }
        const mac = diagAuth.mac;
        const kind = [0, 1, 2].includes(parseInt(body.kind, 10)) ? parseInt(body.kind, 10) : 0;
        const payload = sanitizeDeviceReport(body);
        await dbPool.query('INSERT INTO device_reports (mac_address, kind, payload) VALUES ($1, $2, $3)',
          [mac, kind, JSON.stringify(payload)]);
        await dbPool.query(
          `DELETE FROM device_reports WHERE mac_address = $1 AND id NOT IN
             (SELECT id FROM device_reports WHERE mac_address = $1 ORDER BY id DESC LIMIT 5)`, [mac]).catch(() => {});
        const failed = evaluateReport(payload).filter(c => c.ok === false).map(c => c.label);
        await dbPool.query('INSERT INTO system_events (mac_address, message, category) VALUES ($1, $2, $3)',
          [mac, failed.length ? `Raport centralki: problem — ${failed.join(', ')}` : 'Raport centralki: wszystkie komponenty OK', 'provisioning']).catch(() => {});
        writeToLocalLogFile('Hardware Remote Log', `[Node: ${mac}] Diagnostic report kind=${kind} (${failed.length ? 'FAIL: ' + failed.join(', ') : 'OK'}).`);
        return sendJSON(res, 200, { status: 'stored' });
      }

      // OBSŁUGA PUSH TOKENÓW DLA APLIKACJI MOBILNEJ
      if (pathname === '/api/auth/save_push_token' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const { token } = body;
        if (!token) return sendJSON(res, 400, { error: "Missing push token" });

        await dbPool.query('UPDATE accounts SET push_token = $1 WHERE id = $2', [token, accountId]);
        writeToLocalLogFile('Push System', `Zaktualizowano rejestr push_token dla konta ID: ${accountId}`);
        return sendJSON(res, 200, { success: true });
      }

      // POWIADOMIENIA PUSH PREFERENCJE

      if (pathname === '/api/settings/push_preferences' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const { pushEntries, pushAlarms } = body;

        await dbPool.query('UPDATE accounts SET push_entries = $1, push_alarms = $2 WHERE id = $3', [pushEntries, pushAlarms, accountId]);
        writeToLocalLogFile('Push System', `Zaktualizowano preferencje push dla konta ID: ${accountId} (Entries: ${pushEntries}, Alarms: ${pushAlarms})`);
        return sendJSON(res, 200, { success: true });
      }

// =========================================================================
      // =========================================================================
      // KEYPAD PIN VERIFY — firmware-facing, no JWT, searches keypad_pins table
      // POST { mac, pin }  →  { granted, name? }
      // DB setup: CREATE TABLE keypad_pins (id SERIAL PRIMARY KEY,
      //   account_id INT NOT NULL, name VARCHAR(64) DEFAULT 'Nowy PIN',
      //   pin_hash VARCHAR(255) NOT NULL, active BOOLEAN DEFAULT true,
      //   created_at TIMESTAMP DEFAULT NOW());
      // =========================================================================
      if (pathname === '/api/auth/keypad' && req.method === 'POST') {

        const { pin } = body;
        if (!body.mac || !pin) return sendJSON(res, 400, { error: 'Missing mac or pin' });
        // Bez uwierzytelnienia każdy znający MAC mógł zdalnie zgadywać PIN-y (i blokować
        // klawiaturę właścicielowi limitem prób). Teraz PIN sprawdza tylko prawdziwa
        // centralka; limit prób liczony per centralka — a nie osobno dla MAC-a i MAC-a
        // odwróconego, co wcześniej dawało podwójną pulę prób.
        const kpAuth = await authenticateDevice(req, body.mac);
        if (!kpAuth.ok) {
          logDeviceAuthFailure(kpAuth, body.mac, pathname, cleanIp);
          return sendJSON(res, 401, { granted: false, error: 'device_auth_failed' });
        }
        const mac = kpAuth.mac;
        if (!/^\d{4,8}$/.test(String(pin))) return sendJSON(res, 200, { granted: false });
        const now = Date.now();
        if (!keypadAttempts[mac] || now > keypadAttempts[mac].resetAt)
          keypadAttempts[mac] = { count: 0, resetAt: now + 15 * 60 * 1000 };
        keypadAttempts[mac].count++;
        if (keypadAttempts[mac].count > 5) {
          const wait = Math.ceil((keypadAttempts[mac].resetAt - now) / 1000);
          writeToLocalLogFile('Keypad RateLimit', `[Node: ${mac}] Too many keypad attempts.`);
          return sendJSON(res, 429, { granted: false, error: `Za dużo prób. Poczekaj ${wait}s.` });
        }

        try {
          // Get device's account. Polling already tolerates reversed MAC byte order,
          // so keypad auth should too.
          let deviceMac = mac;
          let devRes = await dbPool.query(
            `SELECT a.id, a.push_token, a.push_alarms, a.push_entries
             FROM accounts a JOIN devices d ON d.account_id = a.id
             WHERE d.mac_address = $1 LIMIT 1`, [mac]);
          if (devRes.rows.length === 0 && mac.includes(':')) {
            const reversedMac = mac.split(':').reverse().join(':');
            const revRes = await dbPool.query(
              `SELECT a.id, a.push_token, a.push_alarms, a.push_entries
               FROM accounts a JOIN devices d ON d.account_id = a.id
               WHERE d.mac_address = $1 LIMIT 1`, [reversedMac]);
            if (revRes.rows.length > 0) {
              deviceMac = reversedMac;
              devRes = revRes;
              writeToLocalLogFile('Keypad', `[Node: ${deviceMac}] Resolved keypad MAC ${mac} as ${deviceMac}.`);
            }
          }
          if (devRes.rows.length === 0)
            return sendJSON(res, 404, { granted: false, error: 'Device not registered' });

          const { id: accountId, push_token, push_alarms } = devRes.rows[0];

          // Sprawdzamy WYŁĄCZNIE aktywne PIN-y przypisane do TEJ centralki (mac),
          // niezależnie od tego, które konto (właściciel czy współadmin) je utworzyło.
          const pinsRes = await dbPool.query(
            `SELECT id, name, pin_hash, schedule_enabled, schedule_days, schedule_start_minutes,
                    schedule_end_minutes, expires_at, max_uses, use_count
             FROM keypad_pins
             WHERE mac_address = $1 AND active = true`, [deviceMac]);

          const nowDate = new Date();
          const nowDayBit = 1 << nowDate.getDay();               // 0=Niedziela..6=Sobota
          const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();

          for (const p of pinsRes.rows) {
            if (!(await bcrypt.compare(String(pin), p.pin_hash))) continue;

            // Kod gościnny wygasł (data ważności minęła)
            if (p.expires_at && new Date(p.expires_at) < nowDate) {
              writeToLocalLogFile('Keypad', `[Node: ${deviceMac}] PIN "${p.name}" DENIED — expired.`);
              return sendJSON(res, 200, { granted: false, reason: 'expired' });
            }

            // Limit użyć wyczerpany (jednorazowe/kilkurazowe kody gościnne)
            if (p.max_uses !== null && p.use_count >= p.max_uses) {
              writeToLocalLogFile('Keypad', `[Node: ${deviceMac}] PIN "${p.name}" DENIED — max uses reached.`);
              return sendJSON(res, 200, { granted: false, reason: 'max_uses' });
            }

            // Harmonogram: dzień tygodnia i okno godzinowe
            if (p.schedule_enabled) {
              const dayOk = (p.schedule_days & nowDayBit) !== 0;
              const timeOk = nowMinutes >= p.schedule_start_minutes && nowMinutes < p.schedule_end_minutes;
              if (!dayOk || !timeOk) {
                writeToLocalLogFile('Keypad', `[Node: ${deviceMac}] PIN "${p.name}" DENIED — outside schedule window.`);
                return sendJSON(res, 200, { granted: false, reason: 'outside_schedule' });
              }
            }

            keypadAttempts[mac] = { count: 0, resetAt: 0 };
            if (p.max_uses !== null) {
              await dbPool.query('UPDATE keypad_pins SET use_count = use_count + 1 WHERE id = $1', [p.id]).catch(() => {});
            }
            writeToLocalLogFile('Keypad', `[Node: ${deviceMac}] PIN "${p.name}" GRANTED.`);
            await dbPool.query(
              'INSERT INTO system_events (mac_address, message, category) VALUES ($1, $2, $3)',
              [deviceMac, `Keypad PIN "${p.name}" - dostep przyznany`, 'entries']).catch(() => {});
            // Powiadomienie push o udanym wejściu — ten sam wzorzec co przy skanie karty RFID,
            // korzysta z push_entries (powiadomienia o wejściach), nie push_alarms (te są dla
            // zdarzeń bezpieczeństwa jak błędny PIN czy sabotaż).
            if (devRes.rows.length > 0) {
              const acc = devRes.rows[0];
              if (acc.push_token && acc.push_entries !== false) {
                sendPushNotification(acc.push_token, "Ktoś wszedł do domu", `${p.name} otworzył(a) drzwi kodem PIN.`);
              }
            }
            return sendJSON(res, 200, { granted: true, name: p.name });
          }

          writeToLocalLogFile('Keypad', `[Node: ${deviceMac}] PIN DENIED (${keypadAttempts[mac].count}/5).`);
          await dbPool.query(
            'INSERT INTO system_events (mac_address, message, category) VALUES ($1, $2, $3)',
            [deviceMac, `Keypad PIN - dostep odrzucony (${keypadAttempts[mac].count}/5)`, 'security']).catch(() => {});
          if (push_token && push_alarms !== false)
            sendPushNotification(push_token, '⚠️ Błędny PIN na klawiaturze',
              `Nieprawidlowa proba PIN z urzadzenia ${deviceMac}`);
          return sendJSON(res, 200, { granted: false });

        } catch (err) {
          writeToLocalLogFile('Keypad ERROR', String(err));
          return sendJSON(res, 500, { granted: false, error: 'Server error' });
        }
      }

      // =========================================================================
      // KEYPAD PIN ADD — JWT protected, app-facing
      // POST { name, pin }  →  { success, id }
      // =========================================================================
      if (pathname === '/api/keypad/add' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const {
          name, pin, mac: reqMac,
          scheduleEnabled = false, scheduleDays = 127,
          scheduleStartMinutes = 0, scheduleEndMinutes = 1440,
          expiresAt = null, maxUses = null, isGuestCode = false
        } = body;
        if (!name || !name.trim()) return sendJSON(res, 400, { error: 'Podaj nazwę' });
        if (!pin || String(pin).length < 4 || String(pin).length > 8)
          return sendJSON(res, 400, { error: 'PIN musi mieć 4–8 cyfr' });
        if (!/^\d+$/.test(String(pin)))
          return sendJSON(res, 400, { error: 'PIN musi zawierać tylko cyfry' });

        // PIN należy do konkretnej centralki. Autoryzacja jak wszędzie: właściciel
        // LUB współadmin danego urządzenia (resolveTargetDevice). Bez mac w body
        // wybieramy pierwszą dostępną centralkę konta (stare zachowanie).
        const kpDev = await resolveTargetDevice(accountId, reqMac);
        if (kpDev.rows.length === 0) return sendJSON(res, 403, { error: 'Brak dostępu do tej centralki' });
        const kpMac = kpDev.rows[0].mac_address;

        // Limit PIN-ów wg pakietu WŁAŚCICIELA centralki (nie twarde 20).
        const kpEnt = await deviceOwnerEntitlements(kpMac);
        const cnt = await dbPool.query(
          'SELECT COUNT(*) FROM keypad_pins WHERE mac_address = $1', [kpMac]);
        if (parseInt(cnt.rows[0].count) >= kpEnt.max_pins)
          return sendJSON(res, 403, {
            error: `Limit PIN-ów (${kpEnt.max_pins}) osiągnięty w pakiecie ${kpEnt.license_tier}. Zwiększ pakiet, aby dodać więcej.`,
            limit: kpEnt.max_pins, used: parseInt(cnt.rows[0].count), tier: kpEnt.license_tier, feature: 'max_pins'
          });
        // Kody gościnne (wygasające / limit użyć) to funkcja płatna — od Silver.
        if (isGuestCode && !kpEnt.guest_codes_enabled)
          return sendJSON(res, 403, {
            error: 'Kody gościnne są dostępne od pakietu Silver.',
            tier: kpEnt.license_tier, feature: 'guest_codes'
          });

        // Anty-Airbnb: limit DODAŃ PIN-ów per centralka w bieżącym miesiącu
        // (pin_changes_per_month; null = bez limitu na tierach płatnych).
        if (kpEnt.pin_changes_per_month != null) {
          const chg = await dbPool.query(
            `SELECT COUNT(*) FROM pin_change_events
               WHERE mac_address = $1 AND action = 'add'
                 AND created_at >= date_trunc('month', NOW())`, [kpMac]);
          if (parseInt(chg.rows[0].count) >= kpEnt.pin_changes_per_month)
            return sendJSON(res, 403, {
              error: `Limit zmian PIN-ów w tym miesiącu (${kpEnt.pin_changes_per_month}) osiągnięty. Zwiększ pakiet, aby dodawać częściej.`,
              limit: kpEnt.pin_changes_per_month, tier: kpEnt.license_tier, feature: 'pin_changes_per_month'
            });
        }

        const hash = await bcrypt.hash(String(pin), 10);
        const ins = await dbPool.query(
          `INSERT INTO keypad_pins
             (account_id, mac_address, name, pin_hash, schedule_enabled, schedule_days,
              schedule_start_minutes, schedule_end_minutes, expires_at, max_uses, is_guest_code)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [accountId, kpMac, name.trim(), hash, scheduleEnabled, scheduleDays,
           scheduleStartMinutes, scheduleEndMinutes, expiresAt, maxUses, isGuestCode]);
        await dbPool.query('INSERT INTO pin_change_events (account_id, mac_address, action) VALUES ($1,$2,$3)', [accountId, kpMac, 'add']);
        writeToLocalLogFile('Keypad', `PIN "${name.trim()}" added for [Node: ${kpMac}] by account ${accountId}${isGuestCode ? ' (guest code)' : ''}`);
        return sendJSON(res, 200, { success: true, id: ins.rows[0].id });
      }

      // KEYPAD PIN UPDATE SCHEDULE/EXPIRY  POST { id, scheduleEnabled, scheduleDays, scheduleStartMinutes, scheduleEndMinutes, expiresAt, maxUses }
      if (pathname === '/api/keypad/update_schedule' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const { id, scheduleEnabled, scheduleDays, scheduleStartMinutes, scheduleEndMinutes, expiresAt, maxUses } = body;
        if (!id) return sendJSON(res, 400, { error: 'Missing id' });
        const r = await dbPool.query(
          `UPDATE keypad_pins SET
             schedule_enabled = COALESCE($1, schedule_enabled),
             schedule_days = COALESCE($2, schedule_days),
             schedule_start_minutes = COALESCE($3, schedule_start_minutes),
             schedule_end_minutes = COALESCE($4, schedule_end_minutes),
             expires_at = $5,
             max_uses = $6
           WHERE id=$7 AND mac_address IN ${macAccessSubquery('$8')}`,
          [scheduleEnabled, scheduleDays, scheduleStartMinutes, scheduleEndMinutes, expiresAt || null, maxUses || null, id, accountId]);
        if (r.rowCount === 0) return sendJSON(res, 404, { error: 'Not found' });
        writeToLocalLogFile('Keypad', `Schedule updated for PIN id=${id}, account ${accountId}`);
        return sendJSON(res, 200, { success: true });
      }

      // KEYPAD PIN DELETE  POST { id }
      if (pathname === '/api/keypad/delete' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const { id } = body;
        if (!id) return sendJSON(res, 400, { error: 'Missing id' });
        const r = await dbPool.query(
          `DELETE FROM keypad_pins WHERE id=$1 AND mac_address IN ${macAccessSubquery('$2')}`, [id, accountId]);
        if (r.rowCount === 0) return sendJSON(res, 404, { error: 'Not found' });
        writeToLocalLogFile('Keypad', `PIN id=${id} deleted by account ${accountId}`);
        return sendJSON(res, 200, { success: true });
      }

      // KEYPAD PIN RENAME  POST { id, name }
      if (pathname === '/api/keypad/rename' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const { id, name } = body;
        if (!id || !name || !name.trim()) return sendJSON(res, 400, { error: 'Missing id or name' });
        const rr = await dbPool.query(
          `UPDATE keypad_pins SET name=$1 WHERE id=$2 AND mac_address IN ${macAccessSubquery('$3')}`,
          [name.trim(), id, accountId]);
        if (rr.rowCount === 0) return sendJSON(res, 404, { error: 'Not found' });
        return sendJSON(res, 200, { success: true });
      }

      // KEYPAD PIN TOGGLE ACTIVE  POST { id }
      if (pathname === '/api/keypad/toggle_active' && req.method === 'POST') {
        const accountId = await requireAuth(req, res); if (!accountId) return;
        const { id } = body;
        if (!id) return sendJSON(res, 400, { error: 'Missing id' });
        const r = await dbPool.query(
          `UPDATE keypad_pins SET active = NOT active WHERE id=$1 AND mac_address IN ${macAccessSubquery('$2')} RETURNING active`,
          [id, accountId]);
        if (r.rowCount === 0) return sendJSON(res, 404, { error: 'Not found' });
        return sendJSON(res, 200, { success: true, active: r.rows[0].active });
      }

      return sendJSON(res, 404, { error: "Endpoint route context invalid" });

    } catch (dbError) {
      console.error("[Database Error Context Fail]", dbError);
      writeToLocalLogFile('CORE PANIC RECOVERY BOUNDARY', `Thread exception crash error: ${dbError.message}`);
      return sendJSON(res, 500, { error: "Internal transactional fault routing" });
    }
  });
});

mailTransport.verify((error, success) => {
  if (error) {
    writeToLocalLogFile('SMTP Handshake Matrix', `CRITICAL REJECTION: Mail relay channel validation failed: ${error.message}`);
  } else {
    writeToLocalLogFile('SMTP Handshake Matrix', 'Handshake clear! Outbound Port 587 TLS channel is online.');
  }
});

// =========================================================================
// LICENCJE — presety tierów i odczyt uprawnień konta.
// Presety to pojedyncze źródło wartości liczbowych dla tierów; klucz licencyjny
// i webhook P24 ustawiają konto na jeden z nich (albo na wartości "individual").
// =========================================================================
const TIER_PRESETS = {
  // max_devices: null = BEZ LIMITU (limit centralek zniesiony 2026-08-17).
  // max_admins LICZY WŁAŚCICIELA. 2 = właściciel + jeden współadmin: typowy nabywca
  // zestawu to dom z dwiema osobami, które obie chcą mieć aplikację. Przy 1 darmowy
  // poziom był dla nich rozczarowaniem od pierwszego dnia (decyzja 2026-09-09,
  // LICENSING.md §3.1). Multi-admin jako upsell działa dopiero od 3. osoby.
  free:       { max_cards: 2,   max_pins: 2,   max_admins: 2,  max_devices: null, log_retention_days: 15, guest_codes_enabled: false, pin_changes_per_month: 4 },
  silver:     { max_cards: 10,  max_pins: 10,  max_admins: 3,  max_devices: null, log_retention_days: 45, guest_codes_enabled: true,  pin_changes_per_month: null },
  gold:       { max_cards: 50,  max_pins: 50,  max_admins: 99, max_devices: null, log_retention_days: 90, guest_codes_enabled: true,  pin_changes_per_month: null },
  individual: { max_cards: 200, max_pins: 200, max_admins: 99, max_devices: null, log_retention_days: 90, guest_codes_enabled: true,  pin_changes_per_month: null },
};

// Odczyt efektywnych uprawnień konta. Wygasła licencja (license_valid_until w
// przeszłości) schodzi do limitów darmowych. Nadmiarowe poświadczenia są potem
// DEZAKTYWOWANE (nie kasowane) przez enforceLicenseLimits() wg wyboru klienta
// (keep_on_downgrade → karta właściciela → najstarsze) — LICENSING.md §3.4,
// README §3.7. Tu tylko odczyt.
async function getEntitlements(accountId) {
  const FREE = { license_tier: 'free', ...TIER_PRESETS.free, license_valid_until: null };
  try {
    const r = await dbPool.query(
      `SELECT license_tier, max_cards, max_pins, max_admins, max_devices,
              log_retention_days, guest_codes_enabled, pin_changes_per_month, license_valid_until
         FROM accounts WHERE id = $1`, [accountId]);
    if (r.rows.length === 0) return { ...FREE };
    const row = r.rows[0];
    const expired = row.license_valid_until && new Date(row.license_valid_until) < new Date();
    if (expired) return { ...FREE, expired: true, license_valid_until: row.license_valid_until };
    return {
      license_tier:          row.license_tier || 'free',
      max_cards:             row.max_cards ?? FREE.max_cards,
      max_pins:              row.max_pins ?? FREE.max_pins,
      max_admins:            row.max_admins ?? FREE.max_admins,
      // LIMIT CENTRALEK ZNIESIONY (decyzja produktowa 2026-08-17): null = bez limitu.
      // Wymuszamy tu, w jednym punkcie, żeby stare wartości w bazie (np. max_devices=1
      // na kontach darmowych) nie blokowały ani rejestracji, ani UI. Sprzedajemy
      // pojemność NA centralkę (karty/PIN-y/admini), a nie liczbę samych urządzeń.
      max_devices:           null,
      log_retention_days:    row.log_retention_days ?? FREE.log_retention_days,
      guest_codes_enabled:   row.guest_codes_enabled ?? false,
      pin_changes_per_month: row.pin_changes_per_month, // null = bez limitu
      license_valid_until:   row.license_valid_until || null,
    };
  } catch (e) {
    writeToLocalLogFile('Core Daemon', `[Entitlements] Błąd odczytu dla konta ${accountId}: ${e.message}`);
    return { ...FREE };
  }
}

// Uprawnienia liczą się wg WŁAŚCICIELA urządzenia (licencja jest właściciela),
// nawet jeśli operację wykonuje zaproszony współadmin.
async function deviceOwnerEntitlements(mac) {
  try {
    const r = await dbPool.query('SELECT account_id FROM devices WHERE mac_address = $1', [mac]);
    if (r.rows.length === 0) return { license_tier: 'free', ...TIER_PRESETS.free, license_valid_until: null };
    return getEntitlements(r.rows[0].account_id);
  } catch (e) {
    return { license_tier: 'free', ...TIER_PRESETS.free, license_valid_until: null };
  }
}

// Migracja schematu: dodajemy kolumny dla harmonogramu dostępu i kodów
// gościnnych do istniejącej tabeli keypad_pins. Bezpieczne do uruchamiania
// przy każdym starcie serwera — IF NOT EXISTS pomija już istniejące kolumny.
async function runSchemaMigrations() {
  const alters = [
    `ALTER TABLE keypad_pins ADD COLUMN IF NOT EXISTS schedule_enabled BOOLEAN DEFAULT false`,
    `ALTER TABLE keypad_pins ADD COLUMN IF NOT EXISTS schedule_days INT DEFAULT 127`,        // bitmask: bit0=Niedziela..bit6=Sobota, 127=wszystkie dni
    `ALTER TABLE keypad_pins ADD COLUMN IF NOT EXISTS schedule_start_minutes INT DEFAULT 0`,   // minuty od północy
    `ALTER TABLE keypad_pins ADD COLUMN IF NOT EXISTS schedule_end_minutes INT DEFAULT 1440`,  // 1440 = 24:00
    `ALTER TABLE keypad_pins ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP DEFAULT NULL`,      // NULL = nigdy nie wygasa
    `ALTER TABLE keypad_pins ADD COLUMN IF NOT EXISTS max_uses INT DEFAULT NULL`,              // NULL = bez limitu
    `ALTER TABLE keypad_pins ADD COLUMN IF NOT EXISTS use_count INT DEFAULT 0`,
    `ALTER TABLE keypad_pins ADD COLUMN IF NOT EXISTS is_guest_code BOOLEAN DEFAULT false`,    // do rozróżnienia w UI
    // PIN-y per centralka: dowiązanie PIN-u do konkretnego urządzenia (mac_address),
    // a nie tylko do konta. Backfill przypina istniejące PIN-y do centralki ich
    // właściciela (idempotentnie — tylko wiersze bez mac_address). Naprawia #3/#4:
    // PIN działał na wszystkich centralkach konta, a PIN współadmina nie działał wcale.
    `ALTER TABLE keypad_pins ADD COLUMN IF NOT EXISTS mac_address VARCHAR(17)`,
    `UPDATE keypad_pins kp SET mac_address = (SELECT d.mac_address FROM devices d WHERE d.account_id = kp.account_id ORDER BY d.mac_address ASC LIMIT 1) WHERE kp.mac_address IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_keypad_pins_mac ON keypad_pins(mac_address)`,
    // Ten sam harmonogram (dni + okno godzinowe) co dla PINów, teraz też dla kart RFID.
    // Karty nie mają expires_at/max_uses/is_guest_code — te pola są specyficzne dla PINów
    // gościnnych i nie mają sensownego odpowiednika dla fizycznej karty.
    `ALTER TABLE card_credentials ADD COLUMN IF NOT EXISTS schedule_enabled BOOLEAN DEFAULT false`,
    `ALTER TABLE card_credentials ADD COLUMN IF NOT EXISTS schedule_days INT DEFAULT 127`,
    `ALTER TABLE card_credentials ADD COLUMN IF NOT EXISTS schedule_start_minutes INT DEFAULT 0`,
    `ALTER TABLE card_credentials ADD COLUMN IF NOT EXISTS schedule_end_minutes INT DEFAULT 1440`,
    // Kategoria zdarzenia (entries/security/connections/provisioning) — pozwala na
    // filtrowanie logów w aplikacji bez konieczności parsowania treści wiadomości.
    // Stare wpisy sprzed tej migracji będą miały category = NULL i pokażą się
    // jako "Inne" w filtrach — to nie jest błąd, tylko naturalna konsekwencja
    // dodania kolumny do istniejącej tabeli z danymi.
    `ALTER TABLE system_events ADD COLUMN IF NOT EXISTS category VARCHAR(20) DEFAULT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_system_events_category ON system_events(category)`,
    `CREATE INDEX IF NOT EXISTS idx_system_events_event_time ON system_events(event_time)`,
    // Token linku zaproszenia współadministratora (akceptacja przez stronę www,
    // obok istniejącego 6-cyfrowego invite_code używanego w aplikacji).
    `ALTER TABLE device_invites ADD COLUMN IF NOT EXISTS invite_token VARCHAR(64)`,
    `CREATE INDEX IF NOT EXISTS idx_device_invites_token ON device_invites(invite_token)`,
    // ---------------------------------------------------------------------
    // LICENCJE (oś sprzedażowa). Pola uprawnień na koncie = jedyne źródło prawdy;
    // tiery to presety tych liczb, "Indywidualna" = po prostu inne wartości bez
    // zmiany kodu. Ustawiane albo automatycznie (webhook P24 po zakupie), albo
    // przez podpisany klucz licencyjny. DEFAULT = tier darmowy, więc każde NOWE
    // konto startuje jako 'free' bez żadnej ingerencji. Przy spadku pakietu
    // enforceLicenseLimits() dezaktywuje (license_locked) karty/PIN-y ponad limit
    // wg wyboru klienta; karta właściciela nigdy nie jest blokowana, więc
    // obniżenie/wygaśnięcie licencji nigdy nie "zamurowuje" zamka (LICENSING §3.4).
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS license_tier VARCHAR(20) DEFAULT 'free'`,
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS max_cards INT DEFAULT 2`,          // per centralka
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS max_pins INT DEFAULT 2`,           // per centralka
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS max_admins INT DEFAULT 2`,         // łącznie z właścicielem (2 = właściciel + 1 współadmin)
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS max_devices INT DEFAULT 1`,        // per konto
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS log_retention_days INT DEFAULT 15`,
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS guest_codes_enabled BOOLEAN DEFAULT false`,
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pin_changes_per_month INT DEFAULT 4`, // 0/NULL = bez limitu (anty-Airbnb dla free)
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS license_valid_until TIMESTAMP DEFAULT NULL`, // NULL = darmowa/bezterminowa
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS p24_customer_ref VARCHAR(64) DEFAULT NULL`,  // powiązanie z operatorem płatności
    // Weryfikacja e-mail kodem 6-cyfrowym przy zakładaniu konta. DEFAULT true =
    // wszystkie ISTNIEJĄCE konta są z automatu zweryfikowane (grandfathering, nie
    // blokujemy nikogo). Rejestracja NOWEGO konta ustawia email_verified=false jawnie
    // i wpisuje kod; login odrzuca konta niezweryfikowane.
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT true`,
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verify_code VARCHAR(6) DEFAULT NULL`,
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verify_expires TIMESTAMP DEFAULT NULL`,
    // Czas otwarcia rygla, ustawiany przez właściciela w aplikacji. PER CENTRALKA —
    // brama wjazdowa potrzebuje dłużej niż drzwi wejściowe. Firmware przyjmuje
    // 1000–60000 ms i sam pilnuje zakresu; serwer wysyła to w odpowiedzi polla.
    `ALTER TABLE devices ADD COLUMN IF NOT EXISTS auto_lock_delay_ms INT DEFAULT 3000`,
    // Egzekwowanie limitów po spadku pakietu (decyzja produktowa 18.08.2026):
    // poświadczenia PONAD limit są DEZAKTYWOWANE, nie kasowane.
    //  * is_owner_card / is_owner_pin — „to moja karta/PIN", nigdy nie wyłączana
    //    automatycznie, żeby właściciel nie został zamknięty przed własnym budynkiem.
    //  * license_locked — wyłączone PRZEZ LIMIT, nie przez człowieka. Rozróżnienie
    //    jest konieczne, żeby po powrocie do wyższego pakietu przywrócić dokładnie te,
    //    które system sam zablokował, a nie te celowo zamrożone przez właściciela.
    `ALTER TABLE card_credentials ADD COLUMN IF NOT EXISTS is_owner_card BOOLEAN DEFAULT false`,
    `ALTER TABLE card_credentials ADD COLUMN IF NOT EXISTS license_locked BOOLEAN DEFAULT false`,
    `ALTER TABLE keypad_pins      ADD COLUMN IF NOT EXISTS is_owner_pin  BOOLEAN DEFAULT false`,
    `ALTER TABLE keypad_pins      ADD COLUMN IF NOT EXISTS license_locked BOOLEAN DEFAULT false`,
    // WYBÓR KLIENTA przed wygaśnięciem licencji — mechanizm GŁÓWNY. Właściciel
    // wskazuje, które poświadczenia mają przetrwać zejście na niższy pakiet.
    // Karta właściciela (is_owner_card) to tylko FALLBACK, gdy nikt nic nie wybrał.
    `ALTER TABLE card_credentials ADD COLUMN IF NOT EXISTS keep_on_downgrade BOOLEAN DEFAULT false`,
    `ALTER TABLE keypad_pins      ADD COLUMN IF NOT EXISTS keep_on_downgrade BOOLEAN DEFAULT false`,
    // Cykl życia zablokowanych przepustek (LICENSING §3.4, 14.09.2026): kiedy zablokowano,
    // czy wysłano ostrzeżenie o kasowaniu; po LOCKED_CREDENTIAL_DAYS wiersz jest usuwany.
    `ALTER TABLE card_credentials ADD COLUMN IF NOT EXISTS license_locked_at TIMESTAMP`,
    `ALTER TABLE keypad_pins      ADD COLUMN IF NOT EXISTS license_locked_at TIMESTAMP`,
    `ALTER TABLE card_credentials ADD COLUMN IF NOT EXISTS license_delete_notice_sent BOOLEAN DEFAULT false`,
    `ALTER TABLE keypad_pins      ADD COLUMN IF NOT EXISTS license_delete_notice_sent BOOLEAN DEFAULT false`,
    // Przypomnienia o końcu pakietu: dla jakiego terminu i który etap (1 = 7 dni, 2 = 1 dzień) wysłano.
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS license_notice_valid_until TIMESTAMP`,
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS license_notice_stage SMALLINT DEFAULT 0`,
    // Podniesienie darmowego limitu administratorów z 1 na 2 (decyzja 2026-09-09,
    // LICENSING.md §3.1). Kolumna powstała z DEFAULT 1, więc konta założone wcześniej
    // miałyby stare ograniczenie. Idempotentne: po pierwszym przebiegu żaden wiersz
    // darmowy nie ma już wartości 1. Dotyka WYŁĄCZNIE kont darmowych — pakietów
    // płatnych i wartości ustawionych ręcznie (individual) nie rusza.
    `UPDATE accounts SET max_admins = 2
       WHERE max_admins = 1 AND (license_tier = 'free' OR license_tier IS NULL)`,
    // Bezpieczeństwo (audyt 2026-09-11, README §7):
    // SHA-256 klucza urządzenia — NULL = centralka sprzed zmiany, przypnie klucz przy
    // pierwszym połączeniu z nowym firmware.
    `ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_key_hash VARCHAR(64) DEFAULT NULL`,
    // Wersja tokenów konta — podbijana przy zmianie/resecie hasła, unieważnia stare JWT.
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS token_version INT DEFAULT 0`,
    // Udziały serwisowe (README §7.15): poza limitem adminów, wygasają same.
    `ALTER TABLE device_shares ADD COLUMN IF NOT EXISTS is_service BOOLEAN DEFAULT false`,
    `ALTER TABLE device_shares ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP DEFAULT NULL`,
  ];
  // Wielu administratorów na jedno urządzenie: konto-właściciel (devices.account_id)
  // pozostaje jedynym uprawnionym do usuwania/zmiany WiFi/zapraszania innych,
  // natomiast zaproszeni administratorzy (device_shares) mogą odblokowywać,
  // zarządzać PIN-ami/kartami i widzieć logi — dokładnie jak właściciel,
  // ale bez uprawnień "właścicielskich".
  const creates = [
    `CREATE TABLE IF NOT EXISTS device_shares (
       id SERIAL PRIMARY KEY,
       mac_address VARCHAR(17) NOT NULL REFERENCES devices(mac_address) ON DELETE CASCADE,
       account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
       invited_by INT REFERENCES accounts(id),
       created_at TIMESTAMP DEFAULT NOW(),
       UNIQUE(mac_address, account_id)
     )`,
    `CREATE TABLE IF NOT EXISTS device_invites (
       id SERIAL PRIMARY KEY,
       mac_address VARCHAR(17) NOT NULL REFERENCES devices(mac_address) ON DELETE CASCADE,
       invited_email VARCHAR(255) NOT NULL,
       invite_code VARCHAR(10) NOT NULL,
       invite_token VARCHAR(64),
       invited_by INT NOT NULL REFERENCES accounts(id),
       created_at TIMESTAMP DEFAULT NOW(),
       expires_at TIMESTAMP NOT NULL,
       used BOOLEAN DEFAULT false
     )`,
    // Kody licencyjne (krótkie, jednorazowe). Operator generuje je na serwerze
    // (licensekey.js) — wpadają tu z tier + dni; klient wpisuje w apce, redeem
    // sprawdza w tej tabeli i oznacza used_by/used_at (atomowo, bez podwójnego użycia).
    `CREATE TABLE IF NOT EXISTS license_codes (
       code VARCHAR(32) PRIMARY KEY,
       tier VARCHAR(20) NOT NULL,
       days INT NOT NULL DEFAULT 365,
       used_by INT REFERENCES accounts(id) ON DELETE SET NULL,
       used_at TIMESTAMP,
       created_at TIMESTAMP DEFAULT NOW()
     )`,
    // Audyt zmian PIN-ów (anty-Airbnb): liczymy dodania per centralka na miesiąc.
    `CREATE TABLE IF NOT EXISTS pin_change_events (
       id SERIAL PRIMARY KEY,
       account_id INT REFERENCES accounts(id) ON DELETE SET NULL,
       mac_address VARCHAR(17),
       action VARCHAR(12),
       created_at TIMESTAMP DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_pin_change_events_mac_time ON pin_change_events(mac_address, created_at)`,
    // Kolejka komend dla centralek (zmiany kart, Wi-Fi) — odbierana w pollu, README §7.3.
    `CREATE TABLE IF NOT EXISTS device_commands (
       id SERIAL PRIMARY KEY,
       mac_address VARCHAR(17) NOT NULL,
       cmd TEXT NOT NULL,
       created_at TIMESTAMP DEFAULT NOW(),
       delivered_at TIMESTAMP,
       acked_at TIMESTAMP
     )`,
    `CREATE INDEX IF NOT EXISTS idx_device_commands_pending ON device_commands(mac_address, acked_at, id)`,
    // Raporty diagnostyczne / self-test z centralek (README §7.15), 5 ostatnich per MAC.
    `CREATE TABLE IF NOT EXISTS device_reports (
       id SERIAL PRIMARY KEY,
       mac_address VARCHAR(17) NOT NULL,
       kind SMALLINT NOT NULL DEFAULT 0,
       payload TEXT NOT NULL,
       created_at TIMESTAMP DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_device_reports_mac ON device_reports(mac_address, id)`,
    // RODO art. 17 — rejestr żądań usunięcia („tombstone"). Trzymamy WYŁĄCZNIE
    // hash e-maila, nigdy samego adresu: inaczej lista usuniętych osób sama byłaby
    // zbiorem danych osobowych. Służy do ponownego zastosowania kasacji, gdyby
    // odtworzono kopię zapasową sprzed usunięcia (wymóg „beyond use" dla backupów).
    // Bez FK do accounts — wiersz ma przeżyć skasowanie konta.
    `CREATE TABLE IF NOT EXISTS erasure_requests (
       id SERIAL PRIMARY KEY,
       email_hash VARCHAR(64) NOT NULL,
       account_id INT,
       requested_at TIMESTAMP DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_erasure_email_hash ON erasure_requests(email_hash)`,
  ];

  let successCount = 0;
  for (const sql of [...alters, ...creates]) {
    try {
      await dbPool.query(sql);
      successCount++;
    } catch (e) {
      // Najczęstsza przyczyna niepowodzenia: użytkownik DB (np. 'admin') nie jest
      // właścicielem tabeli. Loguj GŁOŚNO do master logu, nie tylko do konsoli,
      // żeby to nie zniknęło w tle jak poprzednio.
      writeToLocalLogFile('Core Daemon', `[Migration] BŁĄD: ${e.message} — zapytanie: ${sql.slice(0, 80)}...`);
    }
  }
  writeToLocalLogFile('Core Daemon', `[Migration] Zakończono: ${successCount}/${alters.length + creates.length} instrukcji wykonanych pomyślnie.`);
}
runSchemaMigrations();

// =========================================================================
// RETENCJA / MINIMALIZACJA DANYCH (RODO art. 5) — uruchamiane przy starcie i co 24 h.
// Kasuje stary rejestr zdarzeń oraz zużyte/wygasłe zaproszenia (trzymają e-maile).
// Okres sterowany zmienną LOG_RETENTION_DAYS (domyślnie 90; 0 = wyłączone).
// =========================================================================
async function purgeExpiredData() {
  try {
    // Retencja per-tier: każde urządzenie trzyma logi tyle dni, ile pakiet jego
    // właściciela (log_retention_days). Zdarzenia bez dopasowanego urządzenia
    // (osierocone MAC) sprząta globalny limit LOG_RETENTION_DAYS jako bezpiecznik.
    const evTier = await dbPool.query(
      `DELETE FROM system_events se
         USING devices d, accounts a
        WHERE se.mac_address = d.mac_address
          AND d.account_id = a.id
          AND se.event_time < NOW() - (COALESCE(a.log_retention_days, 15)::int * INTERVAL '1 day')`
    );
    if (evTier.rowCount > 0)
      writeToLocalLogFile('Core Daemon', `[Retention] Usunięto ${evTier.rowCount} zdarzeń wg retencji pakietu.`);
    if (LOG_RETENTION_DAYS > 0) {
      const ev = await dbPool.query(
        `DELETE FROM system_events se
          WHERE NOT EXISTS (SELECT 1 FROM devices d WHERE d.mac_address = se.mac_address)
            AND se.event_time < NOW() - ($1::int * INTERVAL '1 day')`,
        [LOG_RETENTION_DAYS]
      );
      if (ev.rowCount > 0)
        writeToLocalLogFile('Core Daemon', `[Retention] Usunięto ${ev.rowCount} osieroconych zdarzeń starszych niż ${LOG_RETENTION_DAYS} dni.`);
    }
    // Kolejka komend: potwierdzone po 7 dniach (niosą np. hasło Wi-Fi w hex — nie trzymamy
    // ich dłużej niż trzeba); niepotwierdzone tylko, gdy centralki już nie ma w bazie.
    const cmds = await dbPool.query(
      `DELETE FROM device_commands dc
        WHERE (dc.acked_at IS NOT NULL AND dc.acked_at < NOW() - INTERVAL '7 days')
           OR (NOT EXISTS (SELECT 1 FROM devices d WHERE d.mac_address = dc.mac_address)
               AND dc.created_at < NOW() - INTERVAL '30 days')`
    ).catch(() => ({ rowCount: 0 }));
    if (cmds.rowCount > 0)
      writeToLocalLogFile('Core Daemon', `[Retention] Usunięto ${cmds.rowCount} starych komend centralek.`);
    // Udziały serwisowe po terminie — filtr SHARE_ACTIVE i tak je ignoruje, tu sprzątamy wiersze.
    const svcSh = await dbPool.query(`DELETE FROM device_shares WHERE expires_at IS NOT NULL AND expires_at < NOW()`).catch(() => ({ rowCount: 0 }));
    if (svcSh.rowCount > 0)
      writeToLocalLogFile('Core Daemon', `[Retention] Usunięto ${svcSh.rowCount} wygasłych udziałów serwisowych.`);
    const reps = await dbPool.query(`DELETE FROM device_reports WHERE created_at < NOW() - INTERVAL '30 days'`).catch(() => ({ rowCount: 0 }));
    if (reps.rowCount > 0)
      writeToLocalLogFile('Core Daemon', `[Retention] Usunięto ${reps.rowCount} starych raportów diagnostycznych.`);
    // Zaproszenia żyją 48 h — cokolwiek starszego niż 30 dni to martwy rekord z e-mailem.
    const inv = await dbPool.query(
      `DELETE FROM device_invites WHERE created_at < NOW() - INTERVAL '30 days'`
    ).catch(() => ({ rowCount: 0 }));
    if (inv.rowCount > 0)
      writeToLocalLogFile('Core Daemon', `[Retention] Usunięto ${inv.rowCount} przeterminowanych zaproszeń.`);
  } catch (e) {
    writeToLocalLogFile('Core Daemon', `[Retention] BŁĄD: ${e.message}`);
  }
}
purgeExpiredData();
setInterval(purgeExpiredData, 24 * 60 * 60 * 1000);

// =========================================================================
// EGZEKWOWANIE LIMITÓW PAKIETU na istniejących poświadczeniach — przy starcie
// i co 6 h. Wygaśnięcie licencji nie generuje żadnego zdarzenia (to po prostu
// upływ daty), więc ktoś musi je zauważyć — stąd cykliczny przebieg.
// Co 6 h, a nie raz na dobę, żeby po wygaśnięciu nadmiarowe karty nie działały
// jeszcze przez prawie cały dzień.
// =========================================================================
async function enforceLimitsForAllAccounts() {
  try {
    const accs = await dbPool.query('SELECT DISTINCT account_id FROM devices WHERE account_id IS NOT NULL');
    for (const row of accs.rows) await enforceLicenseLimits(row.account_id);
    if (accs.rows.length > 0)
      writeToLocalLogFile('Core Daemon', `[License] Przegląd limitów zakończony dla ${accs.rows.length} kont.`);
  } catch (e) {
    writeToLocalLogFile('Core Daemon', `[License] BŁĄD przeglądu limitów: ${e.message}`);
  }
}
enforceLimitsForAllAccounts();
setInterval(enforceLimitsForAllAccounts, 6 * 60 * 60 * 1000);

// =========================================================================
// CYKL ŻYCIA PAKIETU (LICENSING §3.4, decyzja 14.09.2026), raz na dobę:
//  1. przypomnienie e-mail + push na 7 dni i na 1 dzień przed license_valid_until,
//  2. ostrzeżenie LOCKED_DELETE_NOTICE_DAYS dni przed skasowaniem przepustek
//     zablokowanych przez enforceLicenseLimits(),
//  3. skasowanie przepustek zablokowanych dłużej niż LOCKED_CREDENTIAL_DAYS
//     (karta dodatkowo komendą D|uid do centralki, żeby zniknęła z jej pamięci).
// Przepustka właściciela nigdy nie jest blokowana, więc nigdy tu nie trafia.
// =========================================================================
const LOCKED_CREDENTIAL_DAYS   = Math.max(1, parseInt(process.env.LOCKED_CREDENTIAL_DAYS || '90', 10) || 90);
const LOCKED_DELETE_NOTICE_DAYS = 10;
const LICENSE_REMINDER_STAGES  = [{ stage: 1, days: 7 }, { stage: 2, days: 1 }];

function sendSystemMail(to, subject, text) {
  return new Promise((resolve) => {
    if (!to) return resolve(false);
    try {
      mailTransport.sendMail({ from: '"CTRLABLE Node System" <node@ctrlable.pl>', to, subject, text }, (err) => {
        if (err) writeToLocalLogFile('Mail', `[License] Błąd wysyłki do ${to}: ${err.message}`);
        resolve(!err);
      });
    } catch (e) { writeToLocalLogFile('Mail', `[License] Wyjątek wysyłki do ${to}: ${e.message}`); resolve(false); }
  });
}
const plDate = (d) => new Date(d).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' });

async function licenseExpiryReminders() {
  const r = await dbPool.query(
    `SELECT id, email, push_token, license_tier, license_valid_until, license_notice_valid_until, license_notice_stage
       FROM accounts
      WHERE license_valid_until IS NOT NULL
        AND license_valid_until > NOW()
        AND license_valid_until <= NOW() + INTERVAL '7 days'`);
  for (const a of r.rows) {
    // Nowy termin (odnowienie/kod) = zaczynamy etapy od zera.
    const sameTerm = a.license_notice_valid_until && new Date(a.license_notice_valid_until).getTime() === new Date(a.license_valid_until).getTime();
    let stage = sameTerm ? (a.license_notice_stage || 0) : 0;
    const daysLeft = Math.ceil((new Date(a.license_valid_until) - Date.now()) / 86400000);
    // Docelowy etap dla dzisiejszego dystansu: <=1 dzień = etap 2, <=7 dni = etap 1.
    // Jeden e-mail na przebieg — jeśli serwer stał tydzień, klient dostaje tylko „jutro".
    const targetStage = daysLeft <= 1 ? 2 : 1;
    for (const st of LICENSE_REMINDER_STAGES) {
      if (st.stage !== targetStage || stage >= st.stage) continue;
      const tier = (a.license_tier || 'pakiet').toString();
      const subject = daysLeft <= 1 ? `Pakiet ${tier} wygasa jutro — CTRLABLE Node` : `Pakiet ${tier} wygasa za ${daysLeft} dni — CTRLABLE Node`;
      const text =
`Twój pakiet ${tier} w CTRLABLE Node wygasa ${plDate(a.license_valid_until)}.

Jeśli go nie odnowisz, konto przejdzie na poziom darmowy: 2 karty i 2 kody PIN na centralkę oraz 2 administratorów. Twoja własna karta/PIN właściciela zostanie aktywna zawsze. Pozostałe karty i PIN-y ponad limit zostaną WYŁĄCZONE (nie skasowane) i będą czekać ${LOCKED_CREDENTIAL_DAYS} dni na odnowienie pakietu — po tym czasie zostaną usunięte, a historia wejść skróci się do 15 dni.

Co możesz zrobić już teraz w aplikacji Ctrlable Access → „Pakiet i licencja”:
- wskazać, które karty i PIN-y mają zostać aktywne po zmianie pakietu,
- wpisać nowy kod pakietu (odnowienie).

Kod pakietu otrzymasz, pisząc na node@ctrlable.pl lub dzwoniąc pod 696 088 602.

— CTRLABLE Node`;
      await sendSystemMail(a.email, subject, text);
      sendPushNotification(a.push_token, subject, `Bez odnowienia część kart i PIN-ów zostanie wyłączona. Sprawdź „Pakiet i licencja”.`);
      stage = st.stage;
      await dbPool.query('UPDATE accounts SET license_notice_valid_until = license_valid_until, license_notice_stage = $2 WHERE id = $1', [a.id, stage]);
      writeToLocalLogFile('License', `[Konto ${a.id}] Przypomnienie o końcu pakietu (etap ${stage}, zostało ${daysLeft} dni).`);
    }
  }
}

async function lockedCredentialLifecycle() {
  const noticeAfter = LOCKED_CREDENTIAL_DAYS - LOCKED_DELETE_NOTICE_DAYS;
  // --- ostrzeżenie: zablokowane ≥ (90-10) dni, jeszcze nie ostrzeżone — jeden e-mail na konto ---
  const warn = await dbPool.query(
    `SELECT a.id AS account_id, a.email, a.push_token, d.device_name, d.mac_address,
            x.kind, x.id, x.label, x.license_locked_at
       FROM (
         SELECT 'card' AS kind, id, mac_address, holder_name AS label, license_locked_at, license_delete_notice_sent
           FROM card_credentials WHERE license_locked = true AND is_active = false AND license_locked_at IS NOT NULL
         UNION ALL
         SELECT 'pin'  AS kind, id, mac_address, name AS label, license_locked_at, license_delete_notice_sent
           FROM keypad_pins WHERE license_locked = true AND active = false AND license_locked_at IS NOT NULL
       ) x
       JOIN devices d ON d.mac_address = x.mac_address
       JOIN accounts a ON a.id = d.account_id
      WHERE x.license_delete_notice_sent = false
        AND x.license_locked_at <= NOW() - ($1::int * INTERVAL '1 day')
      ORDER BY a.id, x.license_locked_at`, [noticeAfter]);
  const byAccount = new Map();
  for (const row of warn.rows) {
    if (!byAccount.has(row.account_id)) byAccount.set(row.account_id, { email: row.email, push_token: row.push_token, items: [] });
    byAccount.get(row.account_id).items.push(row);
  }
  for (const [accountId, info] of byAccount) {
    const earliest = info.items.reduce((m, i) => (new Date(i.license_locked_at) < m ? new Date(i.license_locked_at) : m), new Date());
    const deleteOn = new Date(earliest.getTime() + LOCKED_CREDENTIAL_DAYS * 86400000);
    const lines = info.items.map(i => `- ${i.kind === 'card' ? 'karta' : 'PIN'} „${i.label || '(bez nazwy)'}” (${i.device_name || i.mac_address})`).join('\n');
    const text =
`Po zmianie pakietu następujące przepustki są wyłączone i zostaną USUNIĘTE ${plDate(deleteOn)}:

${lines}

Jeśli chcesz je zachować, odnów pakiet przed tą datą — wrócą automatycznie. Po usunięciu kartę trzeba będzie ponownie nauczyć przy czytniku, a PIN nadać od nowa.

Kod pakietu: node@ctrlable.pl, 696 088 602.

— CTRLABLE Node`;
    await sendSystemMail(info.email, `Za ${LOCKED_DELETE_NOTICE_DAYS} dni usuniemy wyłączone przepustki — CTRLABLE Node`, text);
    sendPushNotification(info.push_token, 'Wyłączone przepustki zostaną usunięte', `${info.items.length} kart/PIN-ów zniknie ${plDate(deleteOn)}. Odnów pakiet, żeby je zachować.`);
    const cardIds = info.items.filter(i => i.kind === 'card').map(i => i.id);
    const pinIds  = info.items.filter(i => i.kind === 'pin').map(i => i.id);
    if (cardIds.length) await dbPool.query('UPDATE card_credentials SET license_delete_notice_sent = true WHERE id = ANY($1)', [cardIds]);
    if (pinIds.length)  await dbPool.query('UPDATE keypad_pins SET license_delete_notice_sent = true WHERE id = ANY($1)', [pinIds]);
    writeToLocalLogFile('License', `[Konto ${accountId}] Ostrzeżenie o kasowaniu ${info.items.length} przepustek (${plDate(deleteOn)}).`);
  }

  // --- kasowanie: zablokowane ≥ 90 dni ---
  const cards = await dbPool.query(
    `SELECT c.id, c.mac_address, c.card_uid, c.holder_name, d.account_id
       FROM card_credentials c JOIN devices d ON d.mac_address = c.mac_address
      WHERE c.license_locked = true AND c.is_active = false AND c.is_owner_card = false
        AND c.license_locked_at IS NOT NULL AND c.license_locked_at <= NOW() - ($1::int * INTERVAL '1 day')`, [LOCKED_CREDENTIAL_DAYS]);
  for (const c of cards.rows) {
    await queueCardCommand(c.mac_address, c.card_uid, 'D');   // centralka zapomina kartę (D|uid, bez argumentu)
    await dbPool.query('DELETE FROM card_credentials WHERE id = $1', [c.id]);
    writeToLocalLogFile('License', `[Node: ${c.mac_address}] Karta „${c.holder_name}” (id=${c.id}) usunięta po ${LOCKED_CREDENTIAL_DAYS} dniach blokady pakietu.`);
  }
  const pins = await dbPool.query(
    `DELETE FROM keypad_pins
      WHERE license_locked = true AND active = false AND is_owner_pin = false
        AND license_locked_at IS NOT NULL AND license_locked_at <= NOW() - ($1::int * INTERVAL '1 day')
      RETURNING id, mac_address, name`, [LOCKED_CREDENTIAL_DAYS]);
  for (const p of pins.rows)
    writeToLocalLogFile('License', `[Node: ${p.mac_address}] PIN „${p.name}” (id=${p.id}) usunięty po ${LOCKED_CREDENTIAL_DAYS} dniach blokady pakietu.`);
  if (cards.rows.length || pins.rows.length) {
    // Jedno powiadomienie na konto — właściciel wie, że to nie awaria.
    const accs = new Set(cards.rows.map(c => c.account_id));
    const pinAccount = new Map();
    for (const p of pins.rows) {
      const d = await dbPool.query('SELECT account_id FROM devices WHERE mac_address = $1', [p.mac_address]).catch(() => ({ rows: [] }));
      if (d.rows[0]) { accs.add(d.rows[0].account_id); pinAccount.set(p.id, d.rows[0].account_id); }
    }
    for (const accountId of accs) {
      const a = await dbPool.query('SELECT email, push_token FROM accounts WHERE id = $1', [accountId]).catch(() => ({ rows: [] }));
      if (!a.rows[0]) continue;
      const n = cards.rows.filter(c => c.account_id === accountId).length + pins.rows.filter(p => pinAccount.get(p.id) === accountId).length;
      await sendSystemMail(a.rows[0].email, 'Usunięto wyłączone przepustki — CTRLABLE Node',
`Minęło ${LOCKED_CREDENTIAL_DAYS} dni od wyłączenia przepustek po zmianie pakietu. Zgodnie z regulaminem zostały usunięte (${n}). Karta właściciela i przepustki w ramach pakietu działają bez zmian.

Aby dodać nowe przepustki ponad darmowy limit, aktywuj pakiet w aplikacji (Pakiet i licencja).

— CTRLABLE Node`);
      sendPushNotification(a.rows[0].push_token, 'Usunięto wyłączone przepustki', `${n} kart/PIN-ów usunięto po ${LOCKED_CREDENTIAL_DAYS} dniach blokady pakietu.`);
    }
  }
}

async function runLicenseLifecycle() {
  try { await licenseExpiryReminders(); } catch (e) { writeToLocalLogFile('Core Daemon', `[License] BŁĄD przypomnień: ${e.message}`); }
  try { await lockedCredentialLifecycle(); } catch (e) { writeToLocalLogFile('Core Daemon', `[License] BŁĄD cyklu blokad: ${e.message}`); }
}
// Start z opóźnieniem, żeby migracje i pierwszy przegląd limitów zdążyły się wykonać.
setTimeout(runLicenseLifecycle, 90 * 1000);
setInterval(runLicenseLifecycle, 24 * 60 * 60 * 1000);

server.listen(3000, () => {
  console.log('⚡ Multi-Tenant SmartLock Engine live on port 3000. Writing local filesystem archives at /var/log/smartlock/');
  writeToLocalLogFile('Core Daemon', 'Platform backend environment daemon spun up successfully.');

  // Prefetch latest release ID from GitHub on startup so it's available immediately
  if (GITHUB_PAT) {
    const startupOptions = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/releases/latest`,
      family: 4,
      headers: { 'User-Agent': 'NodeJS-SmartLock-Server', 'Authorization': `token ${GITHUB_PAT}` }
    };
    const startupReq = https.get(startupOptions, (githubRes) => {
      let data = '';
      githubRes.on('data', (chunk) => data += chunk);
      githubRes.on('end', () => {
        try {
          const release = JSON.parse(data);
          if (githubRes.statusCode === 200 && release.id) {
            latestFirmwareReleaseId = release.id;
            latestFirmwareVersion = release.tag_name;
            writeToLocalLogFile('Core Daemon', `Startup GitHub prefetch: ${release.tag_name} (id=${release.id})`);
          }
        } catch (e) {}
      });
    });
    startupReq.on('error', () => {});
  }
});

// ─── Łączność centralek: log tylko przy ZMIANIE stanu ─────────────────────────
// pollSeen[mac] = { at, version, offlineLogged }. Cykliczny ślad polla był szumem
// (i niósł e-mail właściciela co minutę); tu zostają wyłącznie zdarzenia, które
// coś znaczą: pierwszy poll po starcie serwera, powrót po przerwie > 60 s,
// zmiana wersji firmware (potwierdzenie OTA) oraz — z watchdoga — utrata łączności.
const pollSeen = {};
const HEARTBEAT_GAP_MS = 60 * 1000;

function notePollSeen(mac, version, legacy) {
  const nowMs = Date.now();
  const prev = pollSeen[mac];
  const ver = version || '?';
  if (!prev) {
    writeToLocalLogFile('Heartbeat', `[Node: ${mac}] Centralka odpytuje (pierwszy poll od startu serwera) — firmware ${ver}, klucz urządzenia: ${legacy ? 'BRAK (stary firmware)' : 'tak'}.`);
  } else {
    if (prev.offlineLogged || nowMs - prev.at > HEARTBEAT_GAP_MS) {
      writeToLocalLogFile('Heartbeat', `[Node: ${mac}] Centralka wróciła online po ${Math.round((nowMs - prev.at) / 1000)} s przerwy.`);
    }
    if (prev.version && ver !== '?' && prev.version !== ver) {
      writeToLocalLogFile('Heartbeat', `[Node: ${mac}] Zmiana firmware: ${prev.version} → ${ver}.`);
    }
  }
  pollSeen[mac] = { at: nowMs, version: ver, offlineLogged: false };
}

// Watchdog: centralka, która przestała odpytywać, dostaje JEDEN wpis (nie co 30 s).
setInterval(() => {
  const nowMs = Date.now();
  for (const [mac, p] of Object.entries(pollSeen)) {
    if (!p.offlineLogged && nowMs - p.at > HEARTBEAT_GAP_MS) {
      p.offlineLogged = true;
      writeToLocalLogFile('Heartbeat', `[Node: ${mac}] Centralka przestała odpytywać (ostatni poll ${Math.round((nowMs - p.at) / 1000)} s temu).`);
    }
  }
}, 30 * 1000).unref();

// ─── Tryb serwisowy — pomocnicze (README §7.15) ───────────────────────────────
// Udział z akceptacji zaproszenia: dla konta serwisowego oznaczony i wygasający;
// ponowne zaproszenie serwisu odświeża datę wygaśnięcia zamiast być ignorowane.
async function grantShare(mac, accountId, inviteId, email) {
  const service = isServiceEmail(email);
  const expiresAt = service ? new Date(Date.now() + SERVICE_SHARE_HOURS * 3600 * 1000) : null;
  await dbPool.query(
    `INSERT INTO device_shares (mac_address, account_id, invited_by, is_service, expires_at)
     SELECT $1, $2, invited_by, $4, $5 FROM device_invites WHERE id = $3
     ON CONFLICT (mac_address, account_id) DO UPDATE SET is_service = EXCLUDED.is_service, expires_at = EXCLUDED.expires_at`,
    [mac, accountId, inviteId, service, expiresAt]);
  return { service, expiresAt: expiresAt ? expiresAt.toISOString() : null };
}

// Konto serwisowe z AKTYWNYM udziałem na tej centralce (albo 403). Zwraca { mac, deviceName }.
async function requireServiceShare(accountId, rawMac, res) {
  const acc = await dbPool.query('SELECT email FROM accounts WHERE id = $1', [accountId]);
  if (acc.rows.length === 0 || !isServiceEmail(acc.rows[0].email)) {
    _sendJSON(res, 403, { error: 'Tryb serwisowy jest dostępny tylko dla konta serwisowego.' }, '');
    return null;
  }
  const mac = normalizeMac(rawMac);
  if (!mac) { _sendJSON(res, 400, { error: 'Missing mac' }, ''); return null; }
  const r = await dbPool.query(
    `SELECT d.device_name FROM devices d
      WHERE d.mac_address = $1 AND d.mac_address IN (SELECT mac_address FROM device_shares WHERE account_id = $2 AND ${SHARE_ACTIVE})`,
    [mac, accountId]);
  if (r.rows.length === 0) {
    _sendJSON(res, 403, { error: 'Klient nie udostępnił tej centralki serwisowi (albo udział wygasł).' }, '');
    return null;
  }
  return { mac, deviceName: r.rows[0].device_name || mac };
}

// Jak wyżej, ale wymaga też sesji POTWIERDZONEJ kodem z OLED (obecność na miejscu).
async function requireServiceSession(accountId, rawMac, res) {
  const svc = await requireServiceShare(accountId, rawMac, res);
  if (!svc) return null;
  const s = serviceSessions[svc.mac];
  if (!s || s.accountId !== accountId || Date.now() >= s.confirmedUntil) {
    _sendJSON(res, 403, { error: 'Potwierdź obecność kodem z ekranu centralki, aby użyć akcji serwisowych.' }, '');
    return null;
  }
  return svc;
}

async function latestDeviceReport(mac) {
  const r = await dbPool.query(
    'SELECT kind, payload, created_at FROM device_reports WHERE mac_address = $1 ORDER BY id DESC LIMIT 1', [mac]).catch(() => ({ rows: [] }));
  if (r.rows.length === 0) return null;
  let payload = r.rows[0].payload;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_) { payload = {}; } }
  return { kind: r.rows[0].kind, payload: payload || {}, created_at: r.rows[0].created_at };
}

// Raport z centralki to dane od urządzenia — bierzemy tylko znane pola, w znanych typach.
function sanitizeDeviceReport(b) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true');
  const out = {
    fw: String(b.fw || '').slice(0, 32),
    rfid_ver: String(b.rfid_ver || '').slice(0, 8),
    oled: bool(b.oled),
    fs_mounted: bool(b.fs_mounted), fs_selftest: bool(b.fs_selftest),
    fs_total: num(b.fs_total), fs_used: num(b.fs_used),
    kp_installed: bool(b.kp_installed),
    kp_rows: Array.isArray(b.kp_rows) ? b.kp_rows.slice(0, 4).map(bool) : null,
    tamper_installed: bool(b.tamper_installed), tamper_active: bool(b.tamper_active),
    rssi: num(b.rssi), ntp: bool(b.ntp),
    heap_free: num(b.heap_free), heap_min: num(b.heap_min),
    uptime_s: num(b.uptime_s), reset_reason: num(b.reset_reason),
    cards_total: num(b.cards_total),
    relay_test: b.relay_test === undefined ? null : num(b.relay_test),
  };
  if (Array.isArray(b.cards)) {
    out.cards = b.cards.slice(0, 200).map(c => ({
      u: String(c.u || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase().slice(0, 8),
      n: String(c.n || '').slice(0, 24), a: bool(c.a), s: bool(c.s),
    })).filter(c => c.u.length === 8);
  }
  return out;
}

// Ocena raportu prostym językiem — te same reguły dla klienta i serwisu.
// ok: true/false, albo null = informacja bez oceny (np. element niezainstalowany).
function evaluateReport(p) {
  const checks = [];
  const add = (key, label, ok, detail) => checks.push({ key, label, ok, detail });
  const rv = String(p.rfid_ver || '').toUpperCase();
  add('rfid', 'Czytnik kart RFID', rv !== '' && rv !== '00' && rv !== 'FF',
      rv ? `wersja układu 0x${rv}` : 'brak odpowiedzi z czytnika');
  add('oled', 'Wyświetlacz', !!p.oled, p.oled ? 'wykryty' : 'niewykryty na I2C');
  add('storage', 'Pamięć kart (LittleFS)', !!p.fs_mounted && !!p.fs_selftest,
      p.fs_mounted ? `${p.fs_used ?? '?'}/${p.fs_total ?? '?'} B, selftest ${p.fs_selftest ? 'OK' : 'BŁĄD'}` : 'niezamontowana — praca w trybie awaryjnym (EEPROM, 10 kart)');
  if (p.kp_installed) {
    const rows = Array.isArray(p.kp_rows) ? p.kp_rows : [];
    const bad = rows.map((v, i) => (v ? null : i + 1)).filter(Boolean);
    add('keypad', 'Klawiatura', rows.length === 4 && bad.length === 0,
        bad.length ? `wiersz ${bad.join(', ')} zwarty do masy lub brak rezystora` : 'wszystkie wiersze w spoczynku');
  } else add('keypad', 'Klawiatura', null, 'niezainstalowana');
  if (p.tamper_installed) add('tamper', 'Czujnik sabotażu', !p.tamper_active, p.tamper_active ? 'obudowa OTWARTA' : 'obudowa zamknięta');
  else add('tamper', 'Czujnik sabotażu', null, 'niezainstalowany');
  if (p.rssi != null) add('wifi', 'Zasięg Wi-Fi', p.rssi > -80, `${p.rssi} dBm${p.rssi <= -80 ? ' — słaby sygnał, rozważ przeniesienie routera/centralki' : p.rssi <= -70 ? ' — przeciętny' : ' — dobry'}`);
  add('clock', 'Zegar (NTP)', !!p.ntp, p.ntp ? 'zsynchronizowany' : 'brak czasu — harmonogramy kart z ograniczeniem czasowym są odrzucane');
  if (p.heap_free != null) add('memory', 'Pamięć RAM', p.heap_free > 20000 && (p.heap_min == null || p.heap_min > 8000),
      `wolne ${p.heap_free} B${p.heap_min != null ? ', min. ' + p.heap_min + ' B' : ''}`);
  if (p.relay_test != null) add('relay', 'Przekaźnik', p.relay_test === 1, p.relay_test === 1 ? 'test wysterowania wykonany' : 'test nie został wykonany (drzwi były otwarte?)');
  return checks;
}

// Push do WŁAŚCICIELA centralki (np. początek sesji serwisowej) — respektuje push_alarms.
function notifyOwner(mac, title, body) {
  dbPool.query(
    `SELECT a.push_token, a.push_alarms FROM accounts a JOIN devices d ON d.account_id = a.id WHERE d.mac_address = $1 LIMIT 1`, [mac])
    .then((r) => {
      if (r.rows.length && r.rows[0].push_token && r.rows[0].push_token !== 'LOGGED_OUT' && r.rows[0].push_alarms !== false) {
        sendPushNotification(r.rows[0].push_token, title, body);
      }
    }).catch(() => {});
}

function sendPushNotification(token, title, body) {
  if (!token) return;

  // OBSŁUGA TOKENÓW SYMULUJĄCYCH PUSH W ŚRODOWISKU SNACK.EXPO
  if (token.includes('SnackSimulated')) {
    const logFile = '/var/log/smartlock/smartlock_system.log';
    const timestamp = new Date().toISOString();
    const mockLine = `[${timestamp}] [PUSH SIMULATOR] 📱 WYSŁANO PUSH -> Tytuł: "${title}" | Treść: "${body}" (Token: ${token})\n`;

    fs.appendFile(logFile, mockLine, (err) => {
      if (err) console.error(`[Push Mock Error] ${err.message}`);
    });
    console.log(`[PUSH SIMULATOR] Pomyślnie przechwycono powiadomienie dla Snacka: ${title}`);
    return;
  }

  const postData = JSON.stringify({
    to: token,
    sound: 'default',
    title: title,
    body: body,
    badge: 1
  });

  // 🛡️ Bezpieczne obliczenie długości w bajtach (odporne na polskie znaki!)
  const byteLength = Buffer.byteLength(postData, 'utf8');

  const options = {
    hostname: 'exp.host',
    path: '/--/api/v2/push/send',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Accept-encoding': 'gzip, deflate',
      'Content-Length': byteLength // ⬅️ Zmiana na bezpieczną długość bajtową
    }
  };

  const req = https.request(options, (res) => {
    // Expo zwraca odpowiedź w formacie JSON - warto ją chociaż zalogować w razie problemów
    let responseData = '';
    res.on('data', (chunk) => { responseData += chunk; });
    res.on('end', () => {
      if (res.statusCode !== 200) {
        writeToLocalLogFile('Push System Warning', `Bramka Expo zwróciła kod ${res.statusCode}: ${responseData}`);
      }
    });
  });

  req.on('error', (e) => {
    writeToLocalLogFile('Push Notification Error', e.message);
  });

  req.write(postData);
  req.end();
}