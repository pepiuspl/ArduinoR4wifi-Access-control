#!/usr/bin/env node
// =============================================================================
// CTRLABLE — generator krótkich kodów licencyjnych (rejestr w bazie).
// URUCHAMIAĆ NA SERWERZE (backend ma dostęp do bazy przez .env). Kod trafia do
// tabeli license_codes; klient wpisuje go w apce (Pakiet → 🔑 Aktywuj).
// Kod = 16 znaków: prefiks tieru (SLVR/GOLD/INDV) + 12 losowych; pokazywany z
// myślnikami dla czytelności, w bazie bez myślników (redeem i tak normalizuje).
//
// Użycie (na backendzie, w /opt/smartlock-server lub katalogu z server.js):
//   node licensekey.js <silver|gold|individual> [okres]
//   okres: month|quarter|halfyear|year|2y|3y|5y|lifetime  lub liczba dni (domyślnie year)
//   np.:  node licensekey.js gold year      node licensekey.js silver month
// =============================================================================
require('dotenv').config({ path: '/opt/smartlock-server/.env', override: true });
const { Pool } = require('pg');
const crypto = require('crypto');

const PERIODS = { month: 30, quarter: 90, halfyear: 182, year: 365, '2y': 730, '3y': 1095, '5y': 1825, lifetime: 0 };
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // bez mylących 0/O/1/I/L
const PREFIX = { silver: 'SLVR', gold: 'GOLD', individual: 'INDV' };

function genRaw(prefix) {
  let s = prefix;
  for (let i = 0; i < 12; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s; // 16 znaków, bez myślników (postać w bazie)
}
const pretty = (raw) => raw.replace(/(.{4})(?=.)/g, '$1-'); // XXXX-XXXX-XXXX-XXXX

(async () => {
  const tier = process.argv[2];
  const periodArg = process.argv[3];
  if (!PREFIX[tier]) {
    console.error('Użycie: node licensekey.js <silver|gold|individual> [okres]');
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
