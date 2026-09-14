#!/usr/bin/env node
// =============================================================================
// CTRLABLE — generator licencji. Dwa rodzaje (LICENSING.md §3, §3.5):
//
//  1) KOD ONLINE (rejestr w bazie) — URUCHAMIAĆ NA SERWERZE (dostęp do bazy przez
//     .env). Kod trafia do tabeli license_codes; klient wpisuje go w apce
//     (Pakiet → 🔑 Aktywuj). 16 znaków: prefiks tieru (SLVR/GOLD/INDV) + 12 losowych.
//       node licensekey.js <silver|gold|individual> [okres]
//       okres: month|quarter|halfyear|year|2y|3y|5y|lifetime  lub liczba dni (domyślnie year)
//
//  2) TOKEN OFFLINE (podpisany, dla centralki bez konta) — może być generowany
//     WSZĘDZIE, gdzie jest klucz prywatny licencji (laptop, sejf), bez bazy.
//     Token jest związany z MAC-iem konkretnej centralki i BEZTERMINOWY (offline nie
//     ma zaufanego zegara). Centralka sprawdza podpis kluczem publicznym wszytym
//     w firmware (LICENSE_PUBKEY_PEM) — bez klucza prywatnego nie da się go podrobić,
//     a skopiowany na inną sztukę nie przejdzie (inny MAC).
//       node licensekey.js offline <MAC> <silver|gold|individual:KARTY[,PINY]>
//       np.: node licensekey.js offline D4:E9:F4:78:08:60 gold
//            node licensekey.js offline D4:E9:F4:78:08:60 individual:120,120
//     Klucz prywatny: env LICENSE_SIGNING_KEY_FILE albo /opt/smartlock-server/license_private.pem
//     Format: "OFL1." + base64url( payload[12] || podpis ECDSA P-256 (DER) )
//       payload: [0]=wersja(1) [1..6]=MAC [7]=karty [8]=PIN-y [9]=tier(1/2/3) [10..11]=dni od 1970 (BE)
//
//     Sprawdzenie tokenu bez centralki (klucz PUBLICZNY):
//       node licensekey.js offline-verify <token> <license_public.pem>
// =============================================================================
const crypto = require('crypto');
const fs = require('fs');

const PERIODS = { month: 30, quarter: 90, halfyear: 182, year: 365, '2y': 730, '3y': 1095, '5y': 1825, lifetime: 0 };
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // bez mylących 0/O/1/I/L
const PREFIX = { silver: 'SLVR', gold: 'GOLD', individual: 'INDV' };
// Te same poziomy co online (LICENSING.md §3); offline jednorazowo i taniej — brak kosztu serwera.
const OFFLINE_TIERS = { silver: { cards: 10, pins: 10, code: 1 }, gold: { cards: 50, pins: 50, code: 2 }, individual: { cards: null, pins: null, code: 3 } };
const HW_MAX_CARDS = 200;

function genRaw(prefix) {
  let s = prefix;
  for (let i = 0; i < 12; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s; // 16 znaków, bez myślników (postać w bazie)
}
const pretty = (raw) => raw.replace(/(.{4})(?=.)/g, '$1-'); // XXXX-XXXX-XXXX-XXXX

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function parseMac(s) {
  const m = String(s || '').trim().toUpperCase();
  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(m)) throw new Error(`Zły MAC: ${s} (oczekiwany format D4:E9:F4:78:08:60)`);
  return { str: m, bytes: Buffer.from(m.split(':').map(h => parseInt(h, 16))) };
}

function buildOfflinePayload(macBytes, cards, pins, tierCode) {
  const p = Buffer.alloc(12);
  p[0] = 1; macBytes.copy(p, 1);
  p[7] = cards; p[8] = pins; p[9] = tierCode;
  p.writeUInt16BE(Math.floor(Date.now() / 86400000), 10);
  return p;
}

function offlineToken() {
  const mac = parseMac(process.argv[3]);
  const spec = String(process.argv[4] || '');
  const [tierName, custom] = spec.split(':');
  const tier = OFFLINE_TIERS[tierName];
  if (!tier) { console.error('Użycie: node licensekey.js offline <MAC> <silver|gold|individual:KARTY[,PINY]>'); process.exit(1); }
  let cards = tier.cards, pins = tier.pins;
  if (tierName === 'individual') {
    const [c, p] = String(custom || '').split(',').map(x => parseInt(x, 10));
    cards = c; pins = Number.isFinite(p) ? p : c;
  }
  if (!Number.isFinite(cards) || cards < 1 || cards > HW_MAX_CARDS || !Number.isFinite(pins) || pins < 0 || pins > 255) {
    console.error(`Zły limit (karty 1–${HW_MAX_CARDS}, PIN-y 0–255).`); process.exit(1);
  }
  const keyFile = process.env.LICENSE_SIGNING_KEY_FILE || '/opt/smartlock-server/license_private.pem';
  if (!fs.existsSync(keyFile)) { console.error(`Brak klucza prywatnego licencji: ${keyFile} (ustaw LICENSE_SIGNING_KEY_FILE).`); process.exit(1); }
  const key = crypto.createPrivateKey(fs.readFileSync(keyFile));
  const payload = buildOfflinePayload(mac.bytes, cards, pins, tier.code);
  const sig = crypto.sign('sha256', payload, { key, dsaEncoding: 'der' });
  const token = 'OFL1.' + b64url(Buffer.concat([payload, sig]));
  console.log(token);
  console.error(`   (offline ${tierName}: ${cards} kart, ${pins} PIN-ów, centralka ${mac.str}, bezterminowo)`);
  console.error('   Wgranie: fabrycznie na AP CTRLABLE_SETUP → http://192.168.4.1/set_license?token=<TOKEN> (tryb pierwszej konfiguracji)');
  console.error('            albo w aplikacji: Ustawienia (tryb offline) → „Aktywuj licencję" (wklej token).');
}

function offlineVerify() {
  const token = String(process.argv[3] || '');
  const pubFile = process.argv[4];
  if (!token.startsWith('OFL1.') || !pubFile) { console.error('Użycie: node licensekey.js offline-verify <token> <license_public.pem>'); process.exit(1); }
  const raw = unb64url(token.slice(5));
  const payload = raw.subarray(0, 12), sig = raw.subarray(12);
  const ok = crypto.verify('sha256', payload, { key: crypto.createPublicKey(fs.readFileSync(pubFile)), dsaEncoding: 'der' }, sig);
  const mac = Array.from(payload.subarray(1, 7)).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const tierName = Object.keys(OFFLINE_TIERS).find(k => OFFLINE_TIERS[k].code === payload[9]) || '?';
  console.log(JSON.stringify({ valid: ok, version: payload[0], mac, cards: payload[7], pins: payload[8], tier: tierName,
    issued: new Date(payload.readUInt16BE(10) * 86400000).toISOString().slice(0, 10) }));
  process.exit(ok ? 0 : 2);
}

(async () => {
  if (process.argv[2] === 'offline') return offlineToken();
  if (process.argv[2] === 'offline-verify') return offlineVerify();

  // ---- kod ONLINE (baza) ----
  require('dotenv').config({ path: '/opt/smartlock-server/.env', override: true });
  const { Pool } = require('pg');
  const tier = process.argv[2];
  const periodArg = process.argv[3];
  if (!PREFIX[tier]) {
    console.error('Użycie: node licensekey.js <silver|gold|individual> [okres]   |   node licensekey.js offline <MAC> <tier>');
    console.error('  okres: month|quarter|halfyear|year|2y|3y|5y|lifetime  lub liczba dni (domyślnie year)');
    process.exit(1);
  }
  const days = periodArg === undefined ? 365 : (periodArg in PERIODS ? PERIODS[periodArg] : parseInt(periodArg, 10));
  if (Number.isNaN(days) || days < 0) { console.error('Zły okres.'); process.exit(1); }

  const pool = new Pool({
    user: process.env.DB_USER || 'admin',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'smartlock_db',
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432', 10),
  });
  try {
    let raw, ok = false;
    for (let attempt = 0; attempt < 5 && !ok; attempt++) {
      raw = genRaw(PREFIX[tier]);
      try {
        await pool.query('INSERT INTO license_codes (code, tier, days) VALUES ($1,$2,$3)', [raw, tier, days]);
        ok = true;
      } catch (e) {
        if (!String(e.message).toLowerCase().includes('duplicate')) throw e; // kolizja → ponów
      }
    }
    if (!ok) { console.error('Nie udało się wygenerować unikalnego kodu.'); process.exit(1); }
    console.log(pretty(raw));
    console.error(`   (${tier}, ${days > 0 ? days + ' dni' : 'bezterminowo'})`);
  } catch (e) {
    console.error('Błąd bazy:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
