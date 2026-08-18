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
const JWT_SECRET  = process.env.JWT_SECRET  || 'CHANGE_ME_set_JWT_SECRET_env_variable';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';   // token lifetime

if (JWT_SECRET === 'CHANGE_ME_set_JWT_SECRET_env_variable') {
  console.warn('[SECURITY] JWT_SECRET env variable not set — using insecure default. Set it before production use.');
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

function checkRateLimit(store, ip, maxHits, windowMs) {
  const now = Date.now();
  if (!store[ip] || now > store[ip].resetAt) {
    store[ip] = { count: 0, resetAt: now + windowMs };
  }
  store[ip].count;
  if (store[ip].count > maxHits) {
    const retryAfterSec = Math.ceil((store[ip].resetAt - now) / 1000);
    return retryAfterSec;   // seconds to wait
  }
  return 0;   // allowed
}

let otaUpdatePending = false;
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
  connections: ['Radar Traffic', 'Authentication Panel', 'Auth Rejection', 'Auth RateLimit', 'Core Daemon'],
  updates:     ['DEBUG OTA PUSH', 'DEBUG LOCK DOWNLOAD', 'DEBUG GITHUB', 'Hardware Remote Log'],
  security:    ['TAMPER', 'CORE PANIC RECOVERY BOUNDARY', 'Push Diagnostic', 'Push Notification Error', 'Push System Warning'],
  provisioning:['Provisioning', 'Settings Update', 'User Mutation', 'Reset System'],
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
const DEVICE_ACCESS_CONDITION = `(d.account_id = $1 OR d.mac_address IN (SELECT mac_address FROM device_shares WHERE account_id = $1))`;

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
    'SELECT id, is_active, hardware_slot_idx FROM card_credentials WHERE mac_address = $1 ORDER BY id ASC',
    [targetMac]
  );
  if (body && body.id != null) {
    const wanted = parseInt(body.id, 10);
    return cards.rows.find(r => r.id === wanted) || null;
  }
  if (body && body.idx != null) return cards.rows[body.idx] || null;   // stara apka
  return null;
}
// Slot do wysłania na sprzęt: z bazy, a gdy brak (stare wiersze) — to, co podała apka.
function cardHwSlot(card, body) {
  if (card && card.hardware_slot_idx != null) return card.hardware_slot_idx;
  return (body && body.idx != null) ? body.idx : 0;
}

// Fragment SQL: zbiór MAC-ów, do których dane konto ma dostęp jako właściciel LUB
// współadmin. `param` to numer placeholdera (np. '$2'). Używane do autoryzacji
// operacji na PIN-ach po MAC-u urządzenia zamiast po koncie twórcy PIN-u.
function macAccessSubquery(param) {
  return `(SELECT mac_address FROM devices WHERE account_id=${param} UNION SELECT mac_address FROM device_shares WHERE account_id=${param})`;
}

function getFactoryAdminPassword(mac) {
  if (!mac) return 'admin';
  const cleanMac = mac.toUpperCase();
  const salt = "CTRLABLE_KEY_2026";
  const combined = cleanMac + salt;
  let hashNum = 0;
  for (let i = 0; i < combined.length; i++) {
    hashNum += combined.charCodeAt(i) * (i + 1);
  }
  return "CN" + String(hashNum).substring(0, 5);
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
// deregisterQueues[mac] = timestamp do kiedy komenderujemy urządzeniu wipe EEPROM
// (factory reset) i blokujemy jego automatyczną ponowną rejestrację w pollu.
const deregisterCodes = {};
const deregisterQueues = {};
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
function signToken(accountId) {
  if (!jwt) return null;
  return jwt.sign({ sub: String(accountId) }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

/**
 * Verify the Bearer token from the Authorization header.
 * Returns the numeric accountId on success, or null on failure.
 */
function verifyToken(req) {
  if (!jwt) return null;
  const header = req.headers['authorization'] || '';
  const match  = header.match(/^Bearer\s(.+)$/i);
  if (!match) return null;
  try {
    const payload = jwt.verify(match[1], JWT_SECRET);
    return parseInt(payload.sub, 10);
  } catch (_) {
    return null;
  }
}

/**
 * Drop-in guard for protected routes.
 * Usage inside a route block:
 *   const accountId = requireAuth(req, res); if (!accountId) return;
 */
function requireAuth(req, res) {
  const id = verifyToken(req);
  if (!id) {
    // Use the module-level _sendJSON so we can call this before the scoped
    // sendJSON wrapper is available (shouldn't happen in practice, but safe).
    _sendJSON(res, 401, { auth: false, error: 'Token missing or invalid. Please log in again.' },
              req.headers['origin'] || '');
    return null;
  }
  return id;
}

function syncMutationToHardware(ip, pathUrl) {
  return new Promise((resolve) => {
    if (!ip || ip.length < 4) return resolve(false);
    const options = {
      hostname: ip,
      port: 80,
      path: pathUrl,
      method: 'GET',
      timeout: 3000
    };
    const req = http.request(options, (response) => {
      response.on('data', () => {});
      response.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.end();
  });
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
      const match = filename.match(/lock_v\.?([\d.])\.bin/);
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
    const match = latestFile.match(/lock_v\.?([\d.])\.bin/);
    const extractedVersion = match ? match[1] : "0.0.0";
    return { version: extractedVersion, filename: latestFile };
  } catch (e) {
    return { version: '0.0.0', filename: null };
  }
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
    <label>Ustaw hasło (min. 6 znaków)</label>
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
        if(pw.length<6){show('err','Hasło musi mieć co najmniej 6 znaków.');return;}
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
  if (cleanIp === '127.0.0.1' || cleanIp === '::1') cleanIp = '192.168.0.46';

  let bodyStr = '';
  req.on('data', chunk => { bodyStr = chunk; });
  req.on('end', async () => {
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

        // 🛡️ Strażnik RODO - sprawdzenie akceptacji z aplikacji mobilnej
        if (!body.privacy_policy_accepted) {
          return sendJSON(res, 400, { error: "Rejestracja odrzucona. Wymagany akcept polityki prywatności." });
        }

        const cleanEmail = body.email.trim().toLowerCase();
        const hash = await bcrypt.hash(body.password, 10);
        const acceptedTimestamp = new Date(); // Generowanie czasu TIMESTAMP dla Postgresa

        const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();

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
        const userRes = await dbPool.query(
          'SELECT id, email_verified FROM accounts WHERE email = $1 AND email_verify_code = $2 AND email_verify_expires > NOW()',
          [cleanEmail, String(code).trim()]
        );

        if (userRes.rows.length === 0) {
          // Już zweryfikowane? Zwróć spójny sukces, żeby apka nie utknęła.
          const already = await dbPool.query('SELECT id, email_verified FROM accounts WHERE email = $1', [cleanEmail]);
          if (already.rows.length > 0 && already.rows[0].email_verified === true) {
            return sendJSON(res, 200, { status: "already_verified" });
          }
          return sendJSON(res, 400, { error: "Kod jest nieprawidłowy lub wygasł." });
        }

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

        const token = signToken(userRes.rows[0].id);
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
          const freshCode = Math.floor(100000 + Math.random() * 900000).toString();
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
        const token = signToken(result.rows[0].id);
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

        const checkAccount = await dbPool.query('SELECT id FROM accounts WHERE email = $1', [cleanEmail]);
        if (checkAccount.rows.length === 0) {
          return sendJSON(res, 200, { status: "processed" });
        }

        const secureCode = Math.floor(100000 + Math.random() * 900000).toString();

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

      if (pathname === '/api/auth/verify_reset_code' && req.method === 'POST') {
        const { email, code } = body;
        if (!email || !code) return sendJSON(res, 400, { error: "Missing parameters" });

        const cleanEmail = email.trim().toLowerCase();
        const userRes = await dbPool.query(
          'SELECT id FROM accounts WHERE email = $1 AND reset_token = $2 AND reset_token_expires > NOW()',
          [cleanEmail, code]
        );

        if (userRes.rows.length === 0) {
          return sendJSON(res, 400, { error: "Kod jest nieprawidłowy lub wygasł" });
        }

        return sendJSON(res, 200, { valid: true });
      }

      if (pathname === '/api/auth/confirm_password_reset' && req.method === 'POST') {
        const { email, code, newPassword } = body;
        if (!email || !code || !newPassword) return sendJSON(res, 400, { error: "Missing parameters" });

        const cleanEmail = email.trim().toLowerCase();

        const userRes = await dbPool.query(
          'SELECT id FROM accounts WHERE email = $1 AND reset_token = $2 AND reset_token_expires > NOW()',
          [cleanEmail, code]
        );

        if (userRes.rows.length === 0) {
          return sendJSON(res, 400, { error: "Kod jest nieprawidłowy lub wygasł" });
        }

        const hash = await bcrypt.hash(newPassword, 10);
        await dbPool.query(
          'UPDATE accounts SET password_hash = $1, reset_token = null, reset_token_expires = null WHERE id = $2',
          [hash, userRes.rows[0].id]
        );

        writeToLocalLogFile('Reset System', `Hasło zostało pomyślnie zmienione dla: ${cleanEmail}`);
        return sendJSON(res, 200, { success: true });
      }

      // =========================================================================
      // DOSTARCZANIE DANYCH DO APLIKACJI MOBILNEJ
      // =========================================================================
      if (pathname === '/api/data' && req.method === 'GET') {
        const accountId = requireAuth(req, res); if (!accountId) return;

        const accountsRes = await dbPool.query('SELECT email, push_entries, push_alarms FROM accounts WHERE id = $1', [accountId]);
        if (accountsRes.rows.length === 0) return sendJSON(res, 404, { error: "Account invalid" });

        const appAccountContext = { email: accountsRes.rows[0].email };

        // Widoczne są zarówno urządzenia własne, jak i te udostępnione przez
        // innego właściciela (wielu administratorów na jeden zamek).
        const devicesRes = await dbPool.query(
          `SELECT d.*, (d.account_id = $1) AS is_owner
           FROM devices d
           WHERE d.account_id = $1 OR d.mac_address IN (SELECT mac_address FROM device_shares WHERE account_id = $1)
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
          `SELECT id, holder_name as name, is_active as active, card_uid as uid, hardware_slot_idx,
                  schedule_enabled, schedule_days, schedule_start_minutes, schedule_end_minutes
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
          uid: row.uid,
          schedule_enabled: row.schedule_enabled,
          schedule_days: row.schedule_days,
          schedule_start_minutes: row.schedule_start_minutes,
          schedule_end_minutes: row.schedule_end_minutes,
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
          } : null,
          mode: isOffline ? 'Offline' : primaryDevice.operational_mode,
          lock: lockValue,
          total: processedUsersList.length,
          users: processedUsersList,
          logs: localizedLogsFeed,
          version: primaryDevice.firmware_version || latestFirmwareVersion,
          otaPending: otaUpdatePending,
          pushEntries: accountsRes.rows[0].push_entries !== false,
          pushAlarms: accountsRes.rows[0].push_alarms !== false,
          otaProgress: (actualLockStates[primaryMac]?.otaProgress || 0),
          deviceReleaseId: (actualLockStates[primaryMac]?.deviceReleaseId || 0),
          latestReleaseId: latestFirmwareReleaseId,
          autoLockSeconds: Math.round((primaryDevice.auto_lock_delay_ms || 3000) / 1000),
          isOwner: !!primaryDevice.is_owner,   // wyliczane w SELECT (d.account_id = $1)
          keypad_pins: kpPinsRes.rows,
          devices: deviceList,
          activeMac: primaryMac,
        });
      }

      // =========================================================================
      // ZMIANA NAZWY LOKATORA
      // =========================================================================
      if (pathname === '/api/user/rename' && req.method === 'POST') {
        const accountId = requireAuth(req, res); if (!accountId) return;
        const { name, mac: reqMac } = body;
        const dev = await resolveTargetDevice(accountId, reqMac);
        if (dev.rows.length === 0) return sendJSON(res, 404, { error: "Hardware missing mapping" });

        const targetMac = dev.rows[0].mac_address;
        const targetIp = dev.rows[0].last_known_ip;

        const card = await resolveCardRow(targetMac, body);
        if (!card) return sendJSON(res, 400, { error: "Nie znaleziono karty" });

        await dbPool.query('UPDATE card_credentials SET holder_name = $1 WHERE id = $2', [name, card.id]);
        writeToLocalLogFile('User Mutation', `Renamed card profile row ID: ${card.id}`);

        // Wyliczamy hasło algorytmicznie dla tego konkretnego MAC urządzenia
        const currentDynamicPassword = getFactoryAdminPassword(targetMac);

        // Do SPRZĘTU zawsze slot sprzętowy tej karty (nie pozycja w liście!)
        const syncSuccess = await syncMutationToHardware(
        targetIp,
        `/api/rename_user?idx=${cardHwSlot(card, body)}&name=${encodeURIComponent(name)}&pass=${currentDynamicPassword}`
        );
        return sendJSON(res, 200, { status: "ok", hardwareSynced: syncSuccess });
      }

      // =========================================================================
      // AKTUALIZACJA HARMONOGRAMU KARTY RFID (dni + okno godzinowe)
      // POST { idx, mac, scheduleEnabled, scheduleDays, scheduleStartMinutes, scheduleEndMinutes }
      // =========================================================================
      if (pathname === '/api/user/update_schedule' && req.method === 'POST') {
        const accountId = requireAuth(req, res); if (!accountId) return;
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

        // RELAY DO CENTRALKI — bez tego harmonogram żył wyłącznie w bazie i w UI,
        // a urządzenie i tak otwierało drzwi po samym UID (patrz README §5.7).
        // Egzekwowanie jest lokalne, więc dane MUSZĄ trafić na urządzenie.
        const schedPass = getFactoryAdminPassword(targetMac);
        const schedSync = await syncMutationToHardware(
          dev.rows[0].last_known_ip,
          `/api/set_schedule?idx=${cardHwSlot(card, body)}` +
          `&en=${scheduleEnabled ? 1 : 0}` +
          `&days=${scheduleDays != null ? scheduleDays : 127}` +
          `&start=${scheduleStartMinutes != null ? scheduleStartMinutes : 0}` +
          `&end=${scheduleEndMinutes != null ? scheduleEndMinutes : 1440}` +
          `&pass=${schedPass}`
        );
        return sendJSON(res, 200, { success: true, hardwareSynced: schedSync });
      }

      // =========================================================================
      // BLOKOWANIE / AKTYWACJA KARTY
      // =========================================================================
      if (pathname === '/api/user/toggle_active' && req.method === 'POST') {
        const accountId = requireAuth(req, res); if (!accountId) return;
        const { idx, mac: reqMac } = body;
        const dev = await resolveTargetDevice(accountId, reqMac);
        if (dev.rows.length === 0) return sendJSON(res, 404, { error: "Hardware missing mapping" });

        const targetMac = dev.rows[0].mac_address;
        const targetIp = dev.rows[0].last_known_ip;

        const card = await resolveCardRow(targetMac, body);
        if (!card) return sendJSON(res, 400, { error: "Nie znaleziono karty" });

        const flippedStateBit = !card.is_active;
        await dbPool.query('UPDATE card_credentials SET is_active = $1 WHERE id = $2', [flippedStateBit, card.id]);
        writeToLocalLogFile('User Mutation', `Toggled access bit flag for ID: ${card.id}`);

        // Autoryzacja fabrycznym hasłem dynamicznym
        const currentDynamicPassword = getFactoryAdminPassword(targetMac);
        const syncSuccess = await syncMutationToHardware(targetIp, `/api/toggle_user_active?idx=${cardHwSlot(card, body)}&pass=${currentDynamicPassword}`);
        return sendJSON(res, 200, { status: "ok", hardwareSynced: syncSuccess });
      }

      // =========================================================================
      // USUNIĘCIE UŻYTKOWNIKA
      // =========================================================================
      if (pathname === '/api/user/delete' && req.method === 'POST') {
        const accountId = requireAuth(req, res); if (!accountId) return;
        const { idx, mac: reqMac } = body;
        const dev = await resolveTargetDevice(accountId, reqMac);
        if (dev.rows.length === 0) return sendJSON(res, 404, { error: "Hardware missing mapping" });

        const targetMac = dev.rows[0].mac_address;
        const targetIp = dev.rows[0].last_known_ip;

        const card = await resolveCardRow(targetMac, body);
        if (!card) return sendJSON(res, 400, { error: "Nie znaleziono karty" });

        const hwSlot = cardHwSlot(card, body);   // wyliczyć PRZED usunięciem wiersza
        await dbPool.query('DELETE FROM card_credentials WHERE id = $1', [card.id]);
        writeToLocalLogFile('User Mutation', `Purged key ID context entry: ${card.id}`);

        // Autoryzacja fabrycznym hasłem dynamicznym
        const currentDynamicPassword = getFactoryAdminPassword(targetMac);
        const syncSuccess = await syncMutationToHardware(targetIp, `/api/delete_user?idx=${hwSlot}&pass=${currentDynamicPassword}`);
        return sendJSON(res, 200, { status: "ok", hardwareSynced: syncSuccess });
      }

      // =========================================================================
      // ZMIANA HASŁA UŻYTKOWNIKA W USTAWIENIACH
      // =========================================================================
      if (pathname === '/api/settings/password' && req.method === 'POST') {
        const accountId = requireAuth(req, res); if (!accountId) return;
        const { newPassword } = body;
        if (!newPassword || newPassword.length < 6) {
        return sendJSON(res, 400, { error: "Nowe hasło musi mieć minimum 6 znaków." });
        }

        // Hashujemy nowe hasło do APLIKACJI i zapisujemy w tabeli accounts
        const newAccountHash = await bcrypt.hash(newPassword, 10);
        await dbPool.query('UPDATE accounts SET password_hash = $1 WHERE id = $2', [newAccountHash, accountId]);
        writeToLocalLogFile('Settings Update', `Użytkownik ID: ${accountId} zmienił swoje hasło logowania do aplikacji.`);

        // Zwracamy czysty sukces - sprzęt (zamek) jest bezpieczny i nienaruszony
        return sendJSON(res, 200, { success: true });
      }

      // =========================================================================
      // ZMIANA PROFILU WI-FI ZAMKA
      // =========================================================================
      if (pathname === '/api/settings/wifi' && req.method === 'POST') {
        const accountId = requireAuth(req, res); if (!accountId) return;
        const { wifiSSID, wifiPass, mac: reqMac } = body;
        if (!wifiSSID) return sendJSON(res, 400, { error: "SSID cannot be blank" });

        // Pobieramy IP oraz adres MAC urządzenia
        const dev = await resolveTargetDevice(accountId, reqMac);
        if (dev.rows.length === 0) return sendJSON(res, 444, { error: "No system hardware linked" });

        const targetMac = dev.rows[0].mac_address;
        const targetIp = dev.rows[0].last_known_ip;
        writeToLocalLogFile('Settings Update', `[Node: ${targetMac}] Relaying fresh Wi-Fi configuration to ${targetIp}.`);

        // Generujemy hasło na podstawie pobranego adresu MAC
        const currentDynamicPassword = getFactoryAdminPassword(targetMac);
        const syncSuccess = await syncMutationToHardware(targetIp, `/api/save_settings?s=${encodeURIComponent(wifiSSID)}&p=${encodeURIComponent(wifiPass)}&pass=${currentDynamicPassword}`);
        return sendJSON(res, 200, { status: "ok", hardwareSynced: syncSuccess });
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
        const accountId = requireAuth(req, res); if (!accountId) return;

        const params = [accountId];
        let where = `mac_address IN (
          SELECT mac_address FROM devices WHERE account_id = $1
          UNION
          SELECT mac_address FROM device_shares WHERE account_id = $1
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
        const accountId = requireAuth(req, res); if (!accountId) return;
        const devicesRes = await dbPool.query(
          `SELECT mac_address, device_name, operational_mode, firmware_version, last_heartbeat, (account_id = $1) AS is_owner
           FROM devices
           WHERE account_id = $1 OR mac_address IN (SELECT mac_address FROM device_shares WHERE account_id = $1)
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
        const accountId = requireAuth(req, res); if (!accountId) return;
        const ent = await getEntitlements(accountId);
        // Zużycie liczymy dla centralek, których to konto jest WŁAŚCICIELEM
        // (bo licencja jest właściciela). Współadmin widzi limity właściciela.
        const owned = await dbPool.query(
          'SELECT mac_address, device_name FROM devices WHERE account_id = $1 ORDER BY mac_address ASC', [accountId]);
        const usage = [];
        for (const d of owned.rows) {
          const cc = await dbPool.query('SELECT COUNT(*) FROM card_credentials WHERE mac_address = $1', [d.mac_address]);
          const pc = await dbPool.query('SELECT COUNT(*) FROM keypad_pins WHERE mac_address = $1', [d.mac_address]);
          const ac = await dbPool.query('SELECT COUNT(*) FROM device_shares WHERE mac_address = $1', [d.mac_address]);
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
        const accountId = requireAuth(req, res); if (!accountId) return;
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
        return sendJSON(res, 200, { success: true, tier });
      }

      // =========================================================================
      // ZMIANA NAZWY URZĄDZENIA (np. "Drzwi wejściowe", "Garaż")
      // =========================================================================
      if (pathname === '/api/devices/rename' && req.method === 'POST') {
        const accountId = requireAuth(req, res); if (!accountId) return;
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
        const accountId = requireAuth(req, res); if (!accountId) return;
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
      // DEREGISTRACJA — KROK 1: właściciel prosi o kod potwierdzający (mail)
      // POST { mac } — tylko właściciel. Twarde odłączenie centralki.
      // =========================================================================
      if (pathname === '/api/devices/deregister_request' && req.method === 'POST') {
        const accountId = requireAuth(req, res); if (!accountId) return;
        const mac = String(body.mac || '').toUpperCase();
        if (!mac) return sendJSON(res, 400, { error: 'Missing mac' });

        const owned = await dbPool.query(
          `SELECT d.device_name, a.email FROM devices d JOIN accounts a ON a.id = d.account_id
           WHERE d.mac_address = $1 AND d.account_id = $2`, [mac, accountId]);
        if (owned.rows.length === 0) return sendJSON(res, 403, { error: 'Tylko właściciel może odłączyć centralkę.' });

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        deregisterCodes[mac] = { code, accountId, expiresAt: Date.now() + 15 * 60 * 1000 };

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
        const accountId = requireAuth(req, res); if (!accountId) return;
        const mac = String(body.mac || '').toUpperCase();
        const code = String(body.code || '').trim();
        if (!mac || !code) return sendJSON(res, 400, { error: 'Missing mac or code' });

        const entry = deregisterCodes[mac];
        if (!entry || entry.accountId !== accountId || entry.code !== code || Date.now() > entry.expiresAt) {
          return sendJSON(res, 400, { error: 'Kod nieprawidłowy lub wygasł.' });
        }
        const owned = await dbPool.query('SELECT 1 FROM devices WHERE mac_address = $1 AND account_id = $2', [mac, accountId]);
        if (owned.rows.length === 0) return sendJSON(res, 403, { error: 'Tylko właściciel może odłączyć centralkę.' });

        // Usuwamy dane powiązane jawnie (na wypadek braku ON DELETE CASCADE), potem centralkę.
        await dbPool.query('DELETE FROM keypad_pins WHERE mac_address = $1', [mac]).catch(() => {});
        await dbPool.query('DELETE FROM card_credentials WHERE mac_address = $1', [mac]).catch(() => {});
        await dbPool.query('DELETE FROM system_events WHERE mac_address = $1', [mac]).catch(() => {});
        await dbPool.query('DELETE FROM device_shares WHERE mac_address = $1', [mac]).catch(() => {});
        await dbPool.query('DELETE FROM device_invites WHERE mac_address = $1', [mac]).catch(() => {});
        await dbPool.query('DELETE FROM devices WHERE mac_address = $1 AND account_id = $2', [mac, accountId]);

        // Komenda wipe dla urządzenia + krótka blokada auto-rejestracji (okno na odebranie
        // komendy; urządzenie pyta co ~1 s). Krótkie, by nie blokować późniejszego re-prowizjonowania.
        deregisterQueues[mac] = Date.now() + 120 * 1000;
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
        const accountId = requireAuth(req, res); if (!accountId) return;
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
        const adEnt = await getEntitlements(accountId);
        const shCnt = await dbPool.query('SELECT COUNT(*) FROM device_shares WHERE mac_address = $1', [mac.toUpperCase()]);
        const pendCnt = await dbPool.query(
          `SELECT COUNT(*) FROM device_invites WHERE mac_address = $1 AND used = false AND expires_at > NOW()`,
          [mac.toUpperCase()]);
        const adminTotal = parseInt(shCnt.rows[0].count) + parseInt(pendCnt.rows[0].count) + 1;
        if (adminTotal >= adEnt.max_admins)
          return sendJSON(res, 403, {
            error: `Limit administratorów (${adEnt.max_admins}) osiągnięty w pakiecie ${adEnt.license_tier}. Zwiększ pakiet, aby zaprosić kolejnych.`,
            limit: adEnt.max_admins, tier: adEnt.license_tier, feature: 'max_admins'
          });

        const inviteCode = Math.floor(100000 + Math.random() * 900000).toString();
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

        writeToLocalLogFile('Provisioning', `[Node: ${mac.toUpperCase()}] Invite sent to ${cleanEmail} by account ${accountId}.`);
        return sendJSON(res, 200, { status: 'ok' });
      }

      // =========================================================================
      // AKCEPTACJA ZAPROSZENIA — POST { code }, wymaga zalogowania
      // =========================================================================
      if (pathname === '/api/devices/accept_invite' && req.method === 'POST') {
        const accountId = requireAuth(req, res); if (!accountId) return;
        const { code } = body;
        if (!code) return sendJSON(res, 400, { error: 'Podaj kod zaproszenia' });

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

        await dbPool.query(
          `INSERT INTO device_shares (mac_address, account_id, invited_by)
           SELECT $1, $2, invited_by FROM device_invites WHERE id = $3
           ON CONFLICT (mac_address, account_id) DO NOTHING`,
          [invite.mac_address, accountId, invite.id]
        );
        await dbPool.query('UPDATE device_invites SET used = true WHERE id = $1', [invite.id]);

        writeToLocalLogFile('Provisioning', `[Node: ${invite.mac_address}] Account ${accountId} accepted invite, now co-admin.`);
        return sendJSON(res, 200, { status: 'ok', mac: invite.mac_address });
      }

      // =========================================================================
      // LISTA WSPÓŁADMINISTRATORÓW — GET ?mac=X, tylko właściciel
      // =========================================================================
      if (pathname === '/api/devices/shared_users' && req.method === 'GET') {
        const accountId = requireAuth(req, res); if (!accountId) return;
        const mac = (query.mac || '').toUpperCase();
        if (!mac) return sendJSON(res, 400, { error: 'Missing mac' });

        const ownedDevice = await dbPool.query('SELECT 1 FROM devices WHERE mac_address = $1 AND account_id = $2', [mac, accountId]);
        if (ownedDevice.rows.length === 0) return sendJSON(res, 403, { error: 'Tylko właściciel widzi listę administratorów.' });

        const sharesRes = await dbPool.query(
          `SELECT ds.account_id, a.email, ds.created_at
           FROM device_shares ds JOIN accounts a ON a.id = ds.account_id
           WHERE ds.mac_address = $1 ORDER BY ds.created_at ASC`, [mac]
        );
        return sendJSON(res, 200, { admins: sharesRes.rows.map(r => ({ accountId: r.account_id, email: r.email, since: r.created_at })) });
      }

      // =========================================================================
      // ODEBRANIE DOSTĘPU WSPÓŁADMINISTRATOROWI — POST { mac, accountId }, tylko właściciel
      // =========================================================================
      if (pathname === '/api/devices/revoke_share' && req.method === 'POST') {
        const accountId = requireAuth(req, res); if (!accountId) return;
        const { mac, accountId: targetAccountId } = body;
        if (!mac || !targetAccountId) return sendJSON(res, 400, { error: 'Missing mac or accountId' });

        const ownedDevice = await dbPool.query('SELECT 1 FROM devices WHERE mac_address = $1 AND account_id = $2', [mac.toUpperCase(), accountId]);
        if (ownedDevice.rows.length === 0) return sendJSON(res, 403, { error: 'Tylko właściciel może odbierać dostęp.' });

        await dbPool.query('DELETE FROM device_shares WHERE mac_address = $1 AND account_id = $2', [mac.toUpperCase(), targetAccountId]);
        writeToLocalLogFile('Provisioning', `[Node: ${mac.toUpperCase()}] Access revoked for account ${targetAccountId} by owner ${accountId}.`);
        return sendJSON(res, 200, { status: 'ok' });
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
        if (String(password).length < 6) return sendJSON(res, 400, { error: 'Hasło musi mieć co najmniej 6 znaków.' });

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

          await dbPool.query(
            `INSERT INTO device_shares (mac_address, account_id, invited_by)
             SELECT $1, $2, invited_by FROM device_invites WHERE id = $3
             ON CONFLICT (mac_address, account_id) DO NOTHING`,
            [invite.mac_address, targetAccountId, invite.id]);
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
        const accountId = requireAuth(req, res); if (!accountId) return;
        const devRes = await resolveTargetDevice(accountId, query.mac, 'mac_address');
        if (devRes.rows.length > 0) {
          const targetMac = devRes.rows[0].mac_address;

          unlockQueues[targetMac] = true;
          unlockQueues['00:00:00:00:00:00'] = true;

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
            unlockQueues['00:00:00:00:00:00'] = false;
          }, 8000);
        }
        return sendJSON(res, 200, { status: "ok" });
      }

      // =========================================================================
      // WŁĄCZENIE TRYBU UCZENIA CZYTNIKA RFID
      // =========================================================================
      if (pathname === '/api/toggle_learn' && req.method === 'GET') {
        const accountId = requireAuth(req, res); if (!accountId) return;
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
            learningQueues[targetMac] = query.username ? decodeURIComponent(query.username) : 'Nowy Użytkownik';
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
        const ipLookup = await dbPool.query('SELECT mac_address FROM devices WHERE last_known_ip = $1', [cleanIp]);
        const targetMac = ipLookup.rows.length > 0 ? ipLookup.rows[0].mac_address : '00:00:00:00:00:00';

        await dbPool.query('INSERT INTO system_events (mac_address, message, category) VALUES ($1, $2, $3)', [targetMac, 'Naciśnięto przycisk fizyczny', 'entries']);
        writeToLocalLogFile('Hardware Handshake', `[Node: ${targetMac}] Local physical click recorded quietly.`);

        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end("OK");
        return;
      }

      //  UPDATE -- OTA CHECK
      if (pathname === '/api/hardware/log' && req.method === 'GET') {
        const msg = String(query.msg || '').trim();
        const mac = String(query.mac || '00:00:00:00:00:00').toUpperCase();
        let eventMac = mac;
        if (mac.includes(':')) {
          const directDev = await dbPool.query('SELECT mac_address FROM devices WHERE mac_address = $1 LIMIT 1', [mac]).catch(() => ({ rows: [] }));
          if (directDev.rows.length === 0) {
            const reversedMac = mac.split(':').reverse().join(':');
            const revDev = await dbPool.query('SELECT mac_address FROM devices WHERE mac_address = $1 LIMIT 1', [reversedMac]).catch(() => ({ rows: [] }));
            if (revDev.rows.length > 0) eventMac = reversedMac;
          }
        }
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
    const logFile = '/var/log/smartlock/smartlock_system.log';

    const forceLog = (msg) => {
        try {
            fs.appendFileSync(logFile, `[${new Date().toISOString()}] [DEBUG GITHUB] ${msg}\n`);
        } catch (e) {}
    };

    forceLog("Inicjalizacja bezpiecznego zapytania do GitHub API...");

    const options = {
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/releases/latest`,
        family: 4,
        headers: {
            'User-Agent': 'NodeJS-SmartLock-Server',
            'Authorization': `token ${GITHUB_PAT}`
        }
    };

    const githubReq = https.get(options, (githubRes) => {
        let data = '';
        forceLog(`Odebrano odpowiedź z GitHuba. Kod statusu: ${githubRes.statusCode}`);

        githubRes.on('data', (chunk) => data += chunk);
        githubRes.on('end', () => {
            try {
                const release = JSON.parse(data);

                if (githubRes.statusCode !== 200) {
                    forceLog(`GitHub odrzucił autoryzację. Powód: ${release.message}`);
                    if (!res.headersSent) {
                        res.writeHead(githubRes.statusCode, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: release.message }));
                    }
                    return;
                }

                latestFirmwareVersion = release.tag_name;
                latestFirmwareReleaseId = release.id;
                forceLog(`Sukces! Najnowsza wersja na GitHubie to: ${latestFirmwareVersion}`);

                // Wysyłamy odpowiedź do aplikacji tylko, jeśli wątek główny jej nie uprzedził
                if (!res.headersSent) {
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({
                    latestVersion: latestFirmwareVersion,
                    releaseId: latestFirmwareReleaseId  // ADD THIS
                  }));
                }
            } catch (e) {
                forceLog(`Błąd parsowania odpowiedzi JSON z GitHuba: ${e.message}`);
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: "Blad parsowania" }));
                }
            }
        });
    });


    githubReq.on('error', (err) => {
        forceLog(`Krytyczny błąd sieciowy połączenia HTTPS: ${err.message}`);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
    });
    return;
}

    // UPDATE LOGIC -- GET NEW PACKAGE

    if (pathname === '/api/ota/push' && (req.method === 'POST' || req.method === 'GET')) {
      const logFile = '/var/log/smartlock/smartlock_system.log';
      const forceLog = (msg) => {
        try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] [DEBUG OTA PUSH] ${msg}\n`); } catch (e) {}
      };

      forceLog("Inicjalizacja żądania OTA PUSH z aplikacji mobilnej...");

      const options = {
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/releases/latest`,
        family: 4,
        timeout: 8000,
        headers: {
          'User-Agent': 'NodeJS-SmartLock-Server',
          'Authorization': `token ${GITHUB_PAT}`
        }
      };

      const githubReq = https.get(options, (githubRes) => {
        let data = '';
        githubRes.on('data', (chunk) => data += chunk);
        githubRes.on('end', () => {
          try {
            const release = JSON.parse(data);

            if (githubRes.statusCode !== 200) {
              forceLog(`GitHub odrzucił autoryzację: ${release.message}`);
              return sendJSON(res, githubRes.statusCode, { error: release.message });
            }

            // Szukamy pliku .bin, pomijając ewentualne pozostałości merged
            const binAsset = release.assets.find(asset => asset.name.endsWith('.bin') && !asset.name.includes('merged'));
            if (!binAsset) {
              forceLog("Krytyczny błąd: Brak poprawnego pliku .bin w wydaniu GitHub!");
              return sendJSON(res, 404, { error: "Brak właściwego pliku .bin" });
            }

            const targetFileName = binAsset.name;
            const targetFilePath = path.join(updatesDir, targetFileName);

            if (fs.existsSync(targetFilePath) && fs.statSync(targetFilePath).size > 0) {
              forceLog(`[CACHE HIT] Plik ${targetFileName} jest już na dysku Proxmox.`);
              latestFirmwareFile = targetFileName;
              otaUpdatePending = true;
              return sendJSON(res, 200, { success: true, cached: true });
            }

            forceLog(`Rozpoczynam pobieranie paczki z GitHuba: ${targetFileName}...`);

            const downloadOptions = {
              hostname: 'api.github.com',
              path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/releases/assets/${binAsset.id}`,
              family: 4,
              headers: {
                'User-Agent': 'NodeJS-SmartLock-Server',
                'Authorization': `token ${GITHUB_PAT}`,
                'Accept': 'application/octet-stream'
              }
            };

            const fileStream = fs.createWriteStream(targetFilePath);

            // Rekurencyjna funkcja radząca sobie z przekierowaniami 302 (GitHub -> S3)
            const executeDownloadPipeline = (downloadUrl) => {

              // 1. Definiujemy osobną funkcję zwrotną (callback), by kod był czytelny
              const callback = (fileRes) => {
                if (fileRes.statusCode === 302 || fileRes.statusCode === 301) {
                  // Wywołanie rekurencyjne dla nowego adresu URL z nagłówka location
                  executeDownloadPipeline(fileRes.headers.location);
                } else if (fileRes.statusCode === 200) {
                  fileRes.pipe(fileStream);
                  fileStream.on('finish', () => {
                    fileStream.close();
                    latestFirmwareFile = targetFileName;
                    otaUpdatePending = true;
                    forceLog(`Sukces! Nowy soft ${targetFileName} pobrany pomyślnie.`);
                    sendJSON(res, 200, { success: true, cached: false });
                  });
                } else {
                  fileStream.close();
                  try { fs.unlinkSync(targetFilePath); } catch(e) {}
                  sendJSON(res, 500, { error: `S3 Server returned status ${fileRes.statusCode}` });
                }
              };

              // 2. Zamieniamy wszystko na stały obiekt opcji, by uniknąć błędu "listener"
              let finalOptions = {};
              if (typeof downloadUrl === 'string') {
                const urlObj = url.parse(downloadUrl);
                finalOptions = {
                  hostname: urlObj.hostname,
                  path: urlObj.path,
                  port: urlObj.port,
                  protocol: urlObj.protocol,
                  family: 4,
                  headers: { 'User-Agent': 'NodeJS-SmartLock-Server' }
                };
              } else {
                finalOptions = { ...downloadUrl, family: 4 };
              }

              // 3. Wywołujemy żądanie przesyłając ZAWSZE tylko 2 argumenty: (Object, Function)
              const req = https.get(finalOptions, callback);

              req.on('error', (err) => {
                fileStream.close();
                try { fs.unlinkSync(targetFilePath); } catch(e) {}
                forceLog(`Błąd pobierania strumienia: ${err.message}`);
                sendJSON(res, 500, { error: err.message });
              });
            };

            // Uruchomienie bezpiecznego potoku pobierania
            executeDownloadPipeline(downloadOptions);

          } catch (e) {
            forceLog(`Błąd krytyczny parsowania: ${e.message}`);
            sendJSON(res, 500, { error: e.message });
          }
        });
      });

      githubReq.on('error', (err) => {
        forceLog(`Błąd połączenia z GitHub API: ${err.message}`);
        sendJSON(res, 504, { error: "Timeout połączenia z GitHub" });
      });
      return;
    }
      // Return .bin file

      if (pathname === '/api/lock/download-firmware' && req.method === 'GET') {
    const logFile = '/var/log/smartlock/smartlock_system.log';
    const forceLog = (msg) => {
        try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] [DEBUG LOCK DOWNLOAD] ${msg}\n`); } catch (e) {}
    };

    // 🌟 Identyfikujemy urządzenie. Wcześniej ten handler odwoływał się do
    // niezadeklarowanej zmiennej "mac", co rzucało ReferenceError DOKŁADNIE
    // po wysłaniu nagłówków 200 - urządzenie dostawało Content-Length, ale
    // nigdy nie dostawało body, i wyrzucało timeout po 10s. Cała ścieżka
    // "pull" OTA była przez to całkowicie niesprawna.
    let mac = query.mac ? query.mac.toUpperCase() : null;
    if (!mac) {
      const ipLookup = await dbPool.query('SELECT mac_address FROM devices WHERE last_known_ip = $1', [cleanIp]);
      mac = ipLookup.rows.length > 0 ? ipLookup.rows[0].mac_address : '00:00:00:00:00:00';
    }

    if (!latestFirmwareFile) {
        forceLog("Zamek próbował pobrać soft, ale brak zdefiniowanego pliku w pamięci serwera.");
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end("Brak aktywnego pliku aktualizacji.");
    }

    const filePath = path.join(updatesDir, latestFirmwareFile);

    if (fs.existsSync(filePath)) {
        const fileSize = fs.statSync(filePath).size;
        forceLog(`Zamek [${mac}] podłączył się. Rozpoczynam strumieniowanie pliku: ${latestFirmwareFile} (${fileSize} bajtów) do Arduino...`);

        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': fileSize
        });

        const readStream = fs.createReadStream(filePath);
        let transmittedBytes = 0;

        // Scalamy z istniejącym rekordem (stan rygla) - nigdy nie nadpisujemy całości.
        actualLockStates[mac] = { ...(actualLockStates[mac] || {}), otaProgress: 0, timestamp: Date.now() };

        readStream.on('data', (chunk) => {
          transmittedBytes = chunk.length;
          const currentPercentage = Math.round((transmittedBytes / fileSize) * 100);

          // Odświeżamy też "timestamp", żeby urządzenie nie pokazało się jako
          // offline w trakcie długiego transferu (w tym czasie nie pollinguje).
          actualLockStates[mac] = { ...(actualLockStates[mac] || {}), otaProgress: currentPercentage, timestamp: Date.now() };
        });

        readStream.pipe(res);

        readStream.on('end', () => {
            otaUpdatePending = false;
            actualLockStates[mac] = { ...(actualLockStates[mac] || {}), otaProgress: 99, timestamp: Date.now() };
            forceLog(`Sukces! Strumieniowanie pliku ${latestFirmwareFile} do zamka [${mac}] zakończone pomyślnie.`);
        });

        readStream.on('error', (err) => {
          otaUpdatePending = false;
          forceLog(`Błąd podczas przesyłania pliku do zamka [${mac}]: ${err.message}`);
        });

    } else {
        forceLog(`Krytyczny błąd: Plik ${latestFirmwareFile} zniknął z dysku serwera!`);
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end("Plik nie istnieje na dysku.");
    }
    return;
}
      // =========================================================================
      // PROVISIONING: PAROWANIE KOLEJNYCH NOWYCH ZAMKÓW W BAZIE POPRZEZ ADRES MAC
      // =========================================================================
      if (pathname === '/api/device/provision' && req.method === 'POST') {
        const { mac, ownerId, currentIp, firmware } = body;
        // LIMIT CENTRALEK ZNIESIONY — liczba urządzeń na koncie nie jest sprzedawana.
        // Pakiet ogranicza pojemność KAŻDEJ centralki (karty/PIN-y/administratorzy),
        // więc dołożenie kolejnego urządzenia nie omija limitów, tylko dokłada sprzęt.
        await dbPool.query(
          `INSERT INTO devices (mac_address, account_id, last_known_ip, firmware_version)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (mac_address) DO UPDATE
           SET last_known_ip = $3, firmware_version = $4, last_heartbeat = CURRENT_TIMESTAMP`,
          [mac, ownerId, currentIp, firmware]
        );
        return sendJSON(res, 200, { status: "paired" });
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
        const { mac, active } = body;
        if (!mac) return sendJSON(res, 400, { error: 'Missing mac' });

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

        let mac = query.mac;
        if (mac) mac = mac.toUpperCase();

        // DIAGNOSTYKA: bezwarunkowy ślad KAŻDEGO polla (throttle 60s per MAC). Rozstrzyga
        // pytanie „czy centralka w ogóle odpytuje?" — /poll jest wyciszony w Radar Traffic,
        // więc bez tego nie widać go w logach wcale.
        {
          const _k = `arrive:${mac || 'NOMAC'}`;
          if (!provisionSkipLog[_k] || Date.now() - provisionSkipLog[_k] > 60000) {
            provisionSkipLog[_k] = Date.now();
            writeToLocalLogFile('Provisioning', `[Node: ${mac || 'BRAK-MAC'}] POLL przyszedł: email='${query.email || ''}' version='${query.version || ''}' release_id=${query.release_id || '?'} ip=${cleanIp}`);
          }
        }

        // Deregistracja: jeśli ta centralka jest w oknie wyrejestrowania, komenderujemy
        // jej wyczyszczenie (deregister:true) i NIE pozwalamy się ponownie zarejestrować.
        let deregActive = false;
        if (mac && deregisterQueues[mac]) {
          if (Date.now() < deregisterQueues[mac]) deregActive = true;
          else delete deregisterQueues[mac];
        }

        // Jeśli system nie znajdzie takiego adresu MAC w bazie, automatycznie odwracamy bajty,
        // aby zapytania SQL idealnie trafiły w zarejestrowane urządzenie.
        if (mac && mac.includes(':')) {
          let checkDev = await dbPool.query('SELECT mac_address FROM devices WHERE mac_address = $1', [mac]);
          if (checkDev.rows.length === 0) {
            const reversedMac = mac.split(':').reverse().join(':');
            const checkDevRev = await dbPool.query('SELECT mac_address FROM devices WHERE mac_address = $1', [reversedMac]);

            if (checkDevRev.rows.length > 0) {
              mac = reversedMac;
            } else if (query.email && !deregActive) {
              // PROVISIONING: Automatyczne dodanie nowej centralki do bazy danych
              const accountRes = await dbPool.query('SELECT id FROM accounts WHERE email = $1', [query.email.trim().toLowerCase()]);
              if (accountRes.rows.length > 0) {
                // LIMIT CENTRALEK ZNIESIONY — każda nowa centralka rejestruje się
                // niezależnie od pakietu. Limity dotyczą pojemności urządzenia
                // (karty/PIN-y/administratorzy), nie liczby samych urządzeń.
                {
                  await dbPool.query(
                    `INSERT INTO devices (mac_address, account_id, last_known_ip, firmware_version, operational_mode)
                    VALUES ($1, $2, $3, $4, 'Czuwanie')`,
                    [mac, accountRes.rows[0].id, cleanIp, query.version || 'v2.9.6']
                  );
                  writeToLocalLogFile('Provisioning', `[Node: ${mac}] Pomyślnie utworzono i przypisano centralkę do konta: ${query.email}`);
                  // E-mail „dodano centralkę" do właściciela (jednorazowo — ta gałąź
                  // wykonuje się tylko dla NOWEGO MAC-a, już zarejestrowane trafiają wyżej).
                  mailTransport.sendMail({
                    from: '"CTRLABLE Node System" <node@ctrlable.pl>',
                    to: query.email.trim().toLowerCase(),
                    subject: 'Nowa centralka dodana do Twojego konta CTRLABLE',
                    html: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
                        <h2>Centralka została dodana ✓</h2>
                        <p>Nowa centralka CTRLABLE Node właśnie zgłosiła się i została przypisana do Twojego konta.</p>
                        <p style="font-family:monospace; color:#0284c7;">MAC: ${mac}</p>
                        <p>Możesz nią teraz zarządzać w aplikacji — dodać karty RFID i kody PIN. Jeśli to nie Ty dodawałeś urządzenie, skontaktuj się z nami.</p>
                        <br>
                        <p>Pozdrawiamy,<br><strong>Zespół CTRLABLE</strong></p>
                      </div>`
                  }, (err) => { if (err) writeToLocalLogFile('DeviceAdded SMTP Fail', err.message); });
                }
              } else {
                // Poll z e-mailem, ale e-mail NIE pasuje do żadnego konta → rejestracja pominięta.
                // Najczęstsza przyczyna „centralka nie pojawia się na koncie" (zły/pusty e-mail albo
                // konto jeszcze niezałożone/niezweryfikowane). Log throttlowany co 60s.
                if (!provisionSkipLog[mac] || Date.now() - provisionSkipLog[mac] > 60000) {
                  provisionSkipLog[mac] = Date.now();
                  writeToLocalLogFile('Provisioning', `[Node: ${mac}] NIE zarejestrowano: e-mail '${query.email}' nie pasuje do żadnego konta. Załóż i zweryfikuj konto najpierw.`);
                }
              }
            } else {
              // checkDevRev pusty i NIE (email && !deregActive): brak e-maila w pollu albo trwa deregistracja.
              if (mac && mac.includes(':') && (!provisionSkipLog[mac] || Date.now() - provisionSkipLog[mac] > 60000)) {
                provisionSkipLog[mac] = Date.now();
                writeToLocalLogFile('Provisioning', `[Node: ${mac}] POMINIĘTO rejestrację: ${!query.email ? 'brak e-maila w pollu' : 'trwa okno deregistracji (deregister)'}.`);
              }
            }
          }
        }

  // Definiujemy stany na podstawie Twoich globalnych kolejek rygla, zapobiegając ReferenceError
  const unlockAction = !!(unlockQueues[mac] || unlockQueues['00:00:00:00:00:00']);
  const isLearning = !!learningQueues[mac];

  let clientReportedVersion = query.version || null;
  let currentHardwareVersion = '0.0.0';

  // WYCISZONE: Usunięto stąd forceLog ("=== NOWE ZAPYTANIE POLL ==="), całkowicie żegnając sekundowy spam!

  if (!mac) {
    const ipLookup = await dbPool.query('SELECT mac_address, firmware_version FROM devices WHERE last_known_ip = $1', [cleanIp]);
    if (ipLookup.rows.length > 0) {
      mac = ipLookup.rows[0].mac_address;
      currentHardwareVersion = ipLookup.rows[0].firmware_version || '0.0.0';
    } else {
      mac = '00:00:00:00:00:00';
    }
  } else {
    // Zapisujemy i aktualizujemy tętno (heartbeat) urządzenia oraz jego wersję
    let queryText = 'UPDATE devices SET last_heartbeat = CURRENT_TIMESTAMP, last_known_ip = $1 WHERE mac_address = $2 RETURNING firmware_version';
    let queryParams = [cleanIp, mac];

    if (clientReportedVersion) {
      queryText = 'UPDATE devices SET last_heartbeat = CURRENT_TIMESTAMP, last_known_ip = $1, firmware_version = $3 WHERE mac_address = $2 RETURNING firmware_version';
      queryParams = [cleanIp, mac, clientReportedVersion];
    }

    const devLookup = await dbPool.query(queryText, queryParams);
    if (devLookup.rows.length > 0) {
      currentHardwareVersion = devLookup.rows[0].firmware_version || '0.0.0';
    }
  }

  // 🌟 PRAWDA SPRZĘTOWA: centralka w KAŻDYM pollu zgłasza realny stan
  // przekaźnika w parametrze "opened" (1 = drzwi fizycznie otwarte, 0 = zamknięte).
  // To jest JEDYNE miejsce w całym serwerze, gdzie ustawiamy actualLockStates[mac].state -
  // nigdy nie zgadujemy stanu na podstawie samego wysłania komendy z aplikacji,
  // bo wtedy UI pokazywałoby "OTWARTY" zanim zamek faktycznie się odblokuje.
  // Ta sama sanityzacja co przy otaUpdateTrigger — TU jest źródło wartości, którą
  // widzi aplikacja (/api/data -> deviceReleaseId -> ekran „Aktualizacja"). Bez tego
  // apka porównywała 4294967295 >= <id release'u> i meldowała „Jesteś na najnowszej
  // wersji", mimo że urządzenie miało tylko wyczyszczony EEPROM (0xFF).
  let deviceReleaseId = parseInt(query.release_id || '0', 10);
  if (!Number.isFinite(deviceReleaseId) || deviceReleaseId > 4000000000) deviceReleaseId = 0;
  if (query.opened !== undefined) {
    const reportedOpen = query.opened === '1';
    actualLockStates[mac] = {
      ...(actualLockStates[mac] || {}),
      state: reportedOpen,
      timestamp: Date.now(),
      // Fallback też sanityzowany — inaczej raz zapamiętane 4294967295 przeżyłoby
      // każdy kolejny poll (0 || 4294967295 = 4294967295).
      deviceReleaseId: deviceReleaseId || (() => {
        const prev = actualLockStates[mac]?.deviceReleaseId || 0;
        return prev > 4000000000 ? 0 : prev;
      })()
    };
    if (reportedOpen) delete pendingUnlocks[mac];
  } else {
    // Starszy firmware bez pola "opened" - podtrzymujemy tylko heartbeat,
    // nie zmieniamy ostatniego znanego stanu rygla.
    actualLockStates[mac] = { state: false, ...(actualLockStates[mac] || {}), timestamp: Date.now() };
  }

  // Mark OTA as 100% complete when device polls back after restart
  if ((actualLockStates[mac]?.otaProgress || 0) === 99) {
    actualLockStates[mac] = { ...(actualLockStates[mac] || {}), otaProgress: 100 };
  }

  // PRZYWRÓCENIE DZIAŁANIA PRZEKAŹNIKA (Konsumpcja tokenu otwierania z kolejki)
  // Zerujemy TYLKO kolejkę komend - realny stan rygla (powyżej) pochodzi
  // wyłącznie z potwierdzenia sprzętu, nigdy z samego faktu wysłania komendy.
  if (unlockAction) {
    unlockQueues[mac] = false;
    unlockQueues['00:00:00:00:00:00'] = false;
  }

  // PANCERNA LOGIKA OTA (Odporna na pętle i sterowana z aplikacji)
  const latestFw = getLatestFirmwareContext();
  const cleanCurrent = currentHardwareVersion.replace('v', '').trim();
  const cleanLatest = latestFw.version.replace('v', '').trim();

  // Zezwalamy na update TYLKO, gdy wersje się różnią ORAZ kliknięto przycisk w aplikacji (otaUpdatePending === true)
  // Compare by release ID: if the server has a newer release (higher ID) than
  // what the device is running, trigger OTA — even if the version string is identical.
  // latestFirmwareReleaseId comes from the GitHub release object and is always
  // a higher integer for a newer release, regardless of tag name.
  // Sanityzacja ID build-u zgłoszonego przez centralkę: po factory resecie EEPROM
  // jest wypełniony 0xFF, więc urządzenie raportuje 4294967295 — liczbę większą od
  // każdego realnego release'u z GitHuba. Bez tego porównanie (latest > installed)
  // zawsze wypadało na "nie", aplikacja pokazywała „masz najnowszy soft" i OTA
  // nigdy się nie proponowało (a naprawa w firmware wymagałaby... OTA — zapętlenie).
  // Traktujemy takie ID jako "nieznane" (0), więc aktualizacja znów jest oferowana.
  let deviceKnownReleaseId = parseInt(query.release_id || '0', 10);
  if (!Number.isFinite(deviceKnownReleaseId) || deviceKnownReleaseId > 4000000000) {
    deviceKnownReleaseId = 0;
  }
  const otaUpdateTrigger = (
    latestFirmwareReleaseId > 0 &&
    latestFirmwareReleaseId > deviceKnownReleaseId &&
    otaUpdatePending === true
  );
  // Jedyny log, jaki tu zostaje – zapisze się WYŁĄCZNIE w ułamku sekundy, w którym faktycznie rusza aktualizacja
  if (otaUpdateTrigger) {
    forceLog(`[OTA ACTIVATED] Zezwolono urządzeniu [${mac}] na pobranie wersji ${cleanLatest}`);
  }

  // Czas otwarcia rygla ustawiony przez właściciela (per centralka). Firmware nadpisze
  // nim swoją wartość domyślną (przyjmuje 1000–60000 ms). Zapytanie jest lekkie, a poll
  // i tak trafia do bazy wyżej; przy błędzie po prostu nie wysyłamy pola.
  let autoLockDelayMs = null;
  if (mac && mac.includes(':')) {
    const alRes = await dbPool.query('SELECT auto_lock_delay_ms FROM devices WHERE mac_address = $1', [mac])
      .catch(() => ({ rows: [] }));
    if (alRes.rows.length > 0 && alRes.rows[0].auto_lock_delay_ms) {
      autoLockDelayMs = alRes.rows[0].auto_lock_delay_ms;
    }
  }

  return sendJSON(res, 200, {
    unlock: unlockAction,
    learn: isLearning,
    username: learningQueues[mac] || '',
    ota: otaUpdateTrigger,
    deregister: deregActive,
    latest_release_id: latestFirmwareReleaseId,
    latest_version: latestFw.version,
    ...(autoLockDelayMs ? { auto_lock_delay: autoLockDelayMs } : {})
  });
}

      // =========================================================================
      // ODBIERANIE STRUMIENIA TELEMETRII Z ZAMKA
      // =========================================================================
      if ((pathname === '/api/log' || pathname === '/log') && req.method === 'POST') {
        const rawTelemetryLogString = bodyStr.trim();
        const ipLookup = await dbPool.query('SELECT mac_address FROM devices WHERE last_known_ip = $1', [cleanIp]);
        const targetMac = ipLookup.rows.length > 0 ? ipLookup.rows[0].mac_address : '00:00:00:00:00:00';

        if (rawTelemetryLogString.length > 0) {
          await dbPool.query('INSERT INTO system_events (mac_address, message, category) VALUES ($1, $2, $3)', [targetMac, rawTelemetryLogString, 'connections']);
          writeToLocalLogFile('Hardware Ingest', `[Node: ${targetMac}] Telemetry: "${rawTelemetryLogString}"`);
        }
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end("OK");
        return;
      }

      // =========================================================================
      // SPRAWDZANIE WŁAŚCIWOŚCI PERYFERJÓW
      // =========================================================================
      if ((pathname === '/api/hardware/scan' || pathname === '/api/scan' || pathname === '/scan') && req.method === 'POST') {
        let mac = body.mac;
        let uid = body.uid;
        if (!mac) {
          const ipLookup = await dbPool.query('SELECT mac_address FROM devices WHERE last_known_ip = $1', [cleanIp]);
          mac = ipLookup.rows.length > 0 ? ipLookup.rows[0].mac_address : '00:00:00:00:00:00';
        }
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
          unlockQueues[mac] = true;
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
        let mac = body.mac;
        let uid = body.uid;
        let slot = body.slot || 0;

        if (!mac) {
          const ipLookup = await dbPool.query('SELECT mac_address FROM devices WHERE last_known_ip = $1', [cleanIp]);
          mac = ipLookup.rows.length > 0 ? ipLookup.rows[0].mac_address : '00:00:00:00:00:00';
        }
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
      // OBSŁUGA PUSH TOKENÓW DLA APLIKACJI MOBILNEJ
      if (pathname === '/api/auth/save_push_token' && req.method === 'POST') {
        const accountId = requireAuth(req, res); if (!accountId) return;
        const { token } = body;
        if (!token) return sendJSON(res, 400, { error: "Missing push token" });

        await dbPool.query('UPDATE accounts SET push_token = $1 WHERE id = $2', [token, accountId]);
        writeToLocalLogFile('Push System', `Zaktualizowano rejestr push_token dla konta ID: ${accountId}`);
        return sendJSON(res, 200, { success: true });
      }

      // POWIADOMIENIA PUSH PREFERENCJE

      if (pathname === '/api/settings/push_preferences' && req.method === 'POST') {
        const accountId = requireAuth(req, res); if (!accountId) return;
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
        const mac = String(body.mac || '').toUpperCase();
        if (!mac || !pin) return sendJSON(res, 400, { error: 'Missing mac or pin' });
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
        const accountId = requireAuth(req, res); if (!accountId) return;
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
        const accountId = requireAuth(req, res); if (!accountId) return;
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
        const accountId = requireAuth(req, res); if (!accountId) return;
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
        const accountId = requireAuth(req, res); if (!accountId) return;
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
        const accountId = requireAuth(req, res); if (!accountId) return;
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
  free:       { max_cards: 2,   max_pins: 2,   max_admins: 1,  max_devices: null, log_retention_days: 15, guest_codes_enabled: false, pin_changes_per_month: 4 },
  silver:     { max_cards: 10,  max_pins: 10,  max_admins: 3,  max_devices: null, log_retention_days: 45, guest_codes_enabled: true,  pin_changes_per_month: null },
  gold:       { max_cards: 50,  max_pins: 50,  max_admins: 99, max_devices: null, log_retention_days: 90, guest_codes_enabled: true,  pin_changes_per_month: null },
  individual: { max_cards: 200, max_pins: 200, max_admins: 99, max_devices: null, log_retention_days: 90, guest_codes_enabled: true,  pin_changes_per_month: null },
};

// Odczyt efektywnych uprawnień konta. Wygasła licencja (license_valid_until w
// przeszłości) schodzi do limitów darmowych — ale bez kasowania danych: sama
// logika egzekwowania blokuje tylko NOWE dodania ponad limit.
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
    // konto startuje jako 'free' bez żadnej ingerencji. Egzekwowanie blokuje tylko
    // NOWE dodania ponad limit — istniejące karty/PIN-y są zachowane (grandfathering),
    // więc obniżenie/wygaśnięcie licencji nigdy nie "zamurowuje" zamka.
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS license_tier VARCHAR(20) DEFAULT 'free'`,
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS max_cards INT DEFAULT 2`,          // per centralka
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS max_pins INT DEFAULT 2`,           // per centralka
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS max_admins INT DEFAULT 1`,         // łącznie z właścicielem
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
    res.on('data', (chunk) => { responseData = chunk; });
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