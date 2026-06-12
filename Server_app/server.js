const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');

// =========================================================================
// ⚙️ GLOBAL PLATFORM CONFIGURATION SPACE
// =========================================================================

const HARDWARE_OTA_USER = 'admin';
const HARDWARE_OTA_PASS = 'admin'; 

// 🗄️ CONNECT TO THE RELATIONAL POSTGRESQL ENGINE
const dbPool = new Pool({
  user: 'admin',
  host: 'localhost',
  database: 'smartlock_db',
  password: 'Groszowice1!',
  port: 5432,
});

// 📧 REINFORCED PRODUCTION BREVO SMTP RELAY CHANNEL LAYER
const mailTransport = nodemailer.createTransport({
  host: '127.0.0.1',
  port: 25,
  secure: false,
  ignoreTLS: true, // 🌟 Nakazuje Nodemailerowi zignorować brak certyfikatów SSL na porcie 25
  auth: null
});

// 📁 LOCAL FILE LOGGING ENVIRONMENT INITIALIZATION
const logDirectory = '/var/log/smartlock';
const localLogFile = path.join(logDirectory, 'smartlock_system.log');

if (!fs.existsSync(logDirectory)) {
  fs.mkdirSync(logDirectory, { recursive: true });
}

function writeToLocalLogFile(module, message) {
  const timestamp = new Date().toISOString();
  const rawLogLine = `[${timestamp}] [${module}] ${message}
`;
  fs.appendFile(localLogFile, rawLogLine, (err) => {
    if (err) console.error(`[Logging Fault] Failed to write to disk: ${err.message}`);
  });
}

const unlockQueues = {}; 
const learningQueues = {}; 

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
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

// 🌟 DYNAMICZNA FUNKCJA PARSOWANIA I SORTOWANIA WERSJI SEMVER Z PLIKÓW LOKALNYCH
function getLatestFirmwareContext() {
  const updatesDir = '/opt/smartlock-server/updates';
  if (!fs.existsSync(updatesDir)) return { version: '0.0.0', filename: null };

  try {
    const files = fs.readdirSync(updatesDir);
    // Filtrowanie struktury plików: lock_v*.bin
    const binFiles = files.filter(f => f.startsWith('lock_v') && f.endsWith('.bin'));
    
    if (binFiles.length === 0) return { version: '0.0.0', filename: null };

    // Sortowanie SemVer malejąco (od najwyższej do najniższej wersji)
    binFiles.sort((a, b) => {
      const verA = a.replace('lock_v', '').replace('.bin', '').split('.').map(Number);
      const verB = b.replace('lock_v', '').replace('.bin', '').split('.').map(Number);
      
      for (let i = 0; i < Math.max(verA.length, verB.length); i++) {
        const numA = verA[i] || 0;
        const numB = verB[i] || 0;
        if (numA !== numB) return numB - numA;
      }
      return 0;
    });

    const latestFile = binFiles[0];
    const extractedVersion = latestFile.replace('lock_v', '').replace('.bin', '').trim();
    return { version: extractedVersion, filename: latestFile };
  } catch (e) {
    return { version: '0.0.0', filename: null };
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
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
  req.on('data', chunk => { bodyStr += chunk; });
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
      if (pathname === '/api/auth/register' && req.method === 'POST') {
        if (!body.email || !body.password) return sendJSON(res, 400, { error: "Missing identity payloads" });
        const cleanEmail = body.email.trim().toLowerCase();
        const hash = await bcrypt.hash(body.password, 10);
        
        await dbPool.query('INSERT INTO accounts (email, password_hash) VALUES ($1, $2)', [cleanEmail, hash]);
        writeToLocalLogFile('Authentication Panel', `Registered account for: ${cleanEmail}`);
        return sendJSON(res, 200, { status: "registered" });
      }

      if (pathname === '/api/auth/login' && req.method === 'POST') {
        const cleanEmail = body.email.trim().toLowerCase();
        const result = await dbPool.query('SELECT * FROM accounts WHERE email = $1', [cleanEmail]);
        if (result.rows.length === 0) {
          writeToLocalLogFile('Auth Rejection', `Failed login attempt: ${cleanEmail}`);
          return sendJSON(res, 401, { error: "Invalid credentials" });
        }
        const valid = await bcrypt.compare(body.password, result.rows[0].password_hash);
        if (!valid) {
          writeToLocalLogFile('Auth Rejection', `Failed login: ${cleanEmail} (Password hash mismatch)`);
          return sendJSON(res, 401, { error: "Invalid credentials" });
        }
        writeToLocalLogFile('Authentication Panel', `Session authenticated: ${cleanEmail}`);
        return sendJSON(res, 200, { auth: true, accountId: result.rows[0].id });
      }

      if (pathname === '/api/auth/forgot_password' && req.method === 'POST') {
        const cleanEmail = body.email ? body.email.trim().toLowerCase() : '';
        if (!cleanEmail) return sendJSON(res, 400, { error: "Target email missing" });

        const checkAccount = await dbPool.query('SELECT id FROM accounts WHERE email = $1', [cleanEmail]);
        if (checkAccount.rows.length === 0) {
          writeToLocalLogFile('Reset System', `Password reset requested for non-existent user: ${cleanEmail}`);
          return sendJSON(res, 200, { status: "processed" });
        }

        const dynamicTemporaryToken = Math.random().toString(36).slice(-8);
        const tokenHash = await bcrypt.hash(dynamicTemporaryToken, 10);

        await dbPool.query(
          `UPDATE accounts 
           SET password_hash = $1, reset_triggered = true, reset_timestamp = CURRENT_TIMESTAMP 
           WHERE email = $2`,
          [tokenHash, cleanEmail]
        );

        writeToLocalLogFile('Reset System', `Reset flags updated in database for: ${cleanEmail}`);

        const automatedMailManifest = {
          from: '"CTRLABLE Node System" <node@ctrlable.pl>', 
          to: cleanEmail,
          subject: 'CTRLABLE Node Tymczasowo Wygenerowane Hasło',
          text: `Dzień dobry,

Otrzymaliśmy prośbę o zresetowanie hasła do Twojego konta w systemie CTRLABLE Node. 

Twoje nowe, tymczasowe hasło dostępowe to:
${dynamicTemporaryToken}

Ważne: Po zalogowaniu do naszej aplikacji mobilnej, przejdź do sekcji "Ustawienia" i natychmiast zmień hasło na własne.

Jeśli to nie Ty prosiłeś o reset hasła, możesz bezpiecznie zignorować tę wiadomość. 

Pozdrawiamy serdecznie,
Zespół CTRLABLE`,
          html: `<div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; color: #333333; line-height: 1.6;">
  
  <div style="padding: 20px 0; text-align: center;">
    <h2 style="color: #2c3e50; margin-bottom: 0;">Reset hasła w CTRLABLE Node 🔐</h2>
  </div>

  <div style="background-color: #f9fafb; padding: 30px; border-radius: 8px; border: 1px solid #e5e7eb;">
    <p style="margin-top: 0;">Dzień dobry,</p>
    <p>Otrzymaliśmy prośbę o zresetowanie hasła do Twojego konta. Poniżej znajduje się Twoje nowe, tymczasowe hasło dostępowe:</p>

    <div style="text-align: center; margin: 30px 0;">
      <span style="display: inline-block; background-color: #e0f2fe; color: #0284c7; font-family: 'Courier New', Courier, monospace; font-size: 22px; padding: 12px 24px; border-radius: 6px; letter-spacing: 2px; font-weight: bold; border: 1px solid #bae6fd;">
        ${dynamicTemporaryToken}
      </span>
    </div>

    <p>
      <strong>🔒 Co dalej?</strong> Po pomyślnym zalogowaniu do naszej aplikacji mobilnej, przejdź do sekcji <em>Ustawienia</em> i natychmiast zmień hasło na własne.
    </p>

    <p style="margin-bottom: 0; font-size: 13px; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 15px; margin-top: 20px;">
      Jeśli to nie Ty prosiłeś o reset hasła, możesz bezpiecznie zignorować tę wiadomość. Twoje obecne hasło pozostanie niezmienione do momentu użycia powyższego kodu.
    </p>
  </div>

  <div style="margin-top: 20px; font-size: 14px; color: #6b7280; text-align: center;">
    <p>Pozdrawiamy serdecznie,<br><strong style="color: #374151;">Zespół CTRLABLE</strong></p>
  </div>

</div>`
        };

        mailTransport.sendMail(automatedMailManifest, (mailError, info) => {
          if (mailError) {
            writeToLocalLogFile('Reset SMTP Fail', `SMTP Transport Error over Port 587 TLS: ${mailError.message}`);
          } else {
            writeToLocalLogFile('Reset SMTP Success', `Dispatched recovery envelope. Message ID: ${info.messageId}`);
          }
        });

        return sendJSON(res, 200, { status: "processed" });
      }

      if (pathname === '/api/data' && req.method === 'GET') {
        const accountId = query.accountId;
        if (!accountId) return sendJSON(res, 401, { auth: false });

        const accountsRes = await dbPool.query('SELECT email FROM accounts WHERE id = $1', [accountId]);
        if (accountsRes.rows.length === 0) return sendJSON(res, 404, { error: "Account invalid" });
        
        const appAccountContext = { email: accountsRes.rows[0].email };

        const devicesRes = await dbPool.query('SELECT d.* FROM devices d WHERE d.account_id = $1', [accountId]);
        if (devicesRes.rows.length === 0) {
          return sendJSON(res, 200, { auth: true, account: appAccountContext, mode: 'Czuwanie', lock: false, total: 0, users: [], logs: [] });
        }

        const primaryDevice = devicesRes.rows[0];
        const primaryMac = primaryDevice.mac_address;
        
        const usersRes = await dbPool.query('SELECT id, holder_name as name, is_active as active, card_uid as uid FROM card_credentials WHERE mac_address = $1 ORDER BY id ASC', [primaryMac]);
        const logsRes = await dbPool.query('SELECT event_time, message FROM system_events WHERE mac_address = $1 ORDER BY event_time DESC LIMIT 30', [primaryMac]);

        const processedUsersList = usersRes.rows.map((row, index) => ({
          idx: index, 
          name: row.name,
          active: row.active,
          uid: row.uid
        }));

        const localizedLogsFeed = logsRes.rows.map(r => {
          const timestamp = new Date(r.event_time).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          return `[${timestamp}] ${r.message}`;
        });

        return sendJSON(res, 200, {
          auth: true,
          account: appAccountContext, 
          mode: primaryDevice.operational_mode,
          lock: (unlockQueues[primaryMac] || false),
          total: processedUsersList.length,
          users: processedUsersList, 
          logs: localizedLogsFeed,
          version: primaryDevice.firmware_version || '2.9.4'
        });
      }

      if (pathname === '/api/user/rename' && req.method === 'POST') {
        const { accountId, idx, name } = body;
        const dev = await dbPool.query('SELECT mac_address, last_known_ip FROM devices WHERE account_id = $1 LIMIT 1', [accountId]);
        if (dev.rows.length === 0) return sendJSON(res, 404, { error: "Hardware missing mapping" });

        const targetMac = dev.rows[0].mac_address;
        const targetIp = dev.rows[0].last_known_ip;

        const cards = await dbPool.query('SELECT id FROM card_credentials WHERE mac_address = $1 ORDER BY id ASC', [targetMac]);
        if (!cards.rows[idx]) return sendJSON(res, 400, { error: "Array index size exception" });

        await dbPool.query('UPDATE card_credentials SET holder_name = $1 WHERE id = $2', [name, cards.rows[idx].id]);
        writeToLocalLogFile('User Mutation', `Renamed card profile row ID: ${cards.rows[idx].id}`);

        const syncSuccess = await syncMutationToHardware(targetIp, `/api/rename_user?idx=${idx}&name=${encodeURIComponent(name)}&pass=${HARDWARE_OTA_PASS}`);
        return sendJSON(res, 200, { status: "ok", hardwareSynced: syncSuccess });
      }

      if (pathname === '/api/user/toggle_active' && req.method === 'POST') {
        const { accountId, idx } = body;
        const dev = await dbPool.query('SELECT mac_address, last_known_ip FROM devices WHERE account_id = $1 LIMIT 1', [accountId]);
        if (dev.rows.length === 0) return sendJSON(res, 404, { error: "Hardware missing mapping" });

        const targetMac = dev.rows[0].mac_address;
        const targetIp = dev.rows[0].last_known_ip;

        const cards = await dbPool.query('SELECT id, is_active FROM card_credentials WHERE mac_address = $1 ORDER BY id ASC', [targetMac]);
        if (!cards.rows[idx]) return sendJSON(res, 400, { error: "Array index size exception" });

        const flippedStateBit = !cards.rows[idx].is_active;
        await dbPool.query('UPDATE card_credentials SET is_active = $1 WHERE id = $2', [flippedStateBit, cards.rows[idx].id]);
        writeToLocalLogFile('User Mutation', `Toggled access bit flag for ID: ${cards.rows[idx].id}`);

        const syncSuccess = await syncMutationToHardware(targetIp, `/api/toggle_user_active?idx=${idx}&pass=${HARDWARE_OTA_PASS}`);
        return sendJSON(res, 200, { status: "ok", hardwareSynced: syncSuccess });
      }

      if (pathname === '/api/user/delete' && req.method === 'POST') {
        const { accountId, idx } = body;
        const dev = await dbPool.query('SELECT mac_address, last_known_ip FROM devices WHERE account_id = $1 LIMIT 1', [accountId]);
        if (dev.rows.length === 0) return sendJSON(res, 404, { error: "Hardware missing mapping" });

        const targetMac = dev.rows[0].mac_address;
        const targetIp = dev.rows[0].last_known_ip;

        const cards = await dbPool.query('SELECT id FROM card_credentials WHERE mac_address = $1 ORDER BY id ASC', [targetMac]);
        if (!cards.rows[idx]) return sendJSON(res, 400, { error: "Array index size exception" });

        await dbPool.query('DELETE FROM card_credentials WHERE id = $1', [cards.rows[idx].id]);
        writeToLocalLogFile('User Mutation', `Purged key ID context entry: ${cards.rows[idx].id}`);

        const syncSuccess = await syncMutationToHardware(targetIp, `/api/delete_user?idx=${idx}&pass=${HARDWARE_OTA_PASS}`);
        return sendJSON(res, 200, { status: "ok", hardwareSynced: syncSuccess });
      }

      if (pathname === '/api/settings/password' && req.method === 'POST') {
        const { accountId, newPassword } = body;
        if (!newPassword || newPassword.length < 4) return sendJSON(res, 400, { error: "New password too short" });

        const dev = await dbPool.query('SELECT last_known_ip FROM devices WHERE account_id = $1 LIMIT 1', [accountId]);
        const targetIp = dev.rows.length > 0 ? dev.rows[0].last_known_ip : '';

        const newAdminHash = await bcrypt.hash(newPassword, 10);
        await dbPool.query('UPDATE accounts SET password_hash = $1 WHERE id = $2', [newAdminHash, accountId]);
        writeToLocalLogFile('Settings Update', `Modified master password for account id: ${accountId}`);

        let hardwareSynced = false;
        if (targetIp) {
          hardwareSynced = await syncMutationToHardware(targetIp, `/api/save_settings?a=${encodeURIComponent(newPassword)}&pass=${HARDWARE_OTA_PASS}`);
        }
        return sendJSON(res, 200, { status: "ok", hardwareSynced });
      }

      if (pathname === '/api/settings/wifi' && req.method === 'POST') {
        const { accountId, wifiSSID, wifiPass } = body;
        if (!wifiSSID) return sendJSON(res, 400, { error: "SSID cannot be blank" });

        const dev = await dbPool.query('SELECT last_known_ip FROM devices WHERE account_id = $1 LIMIT 1', [accountId]);
        if (dev.rows.length === 0) return sendJSON(res, 444, { error: "No system hardware linked" });

        const targetIp = dev.rows[0].last_known_ip;
        writeToLocalLogFile('Settings Update', `Relaying fresh Wi-Fi configuration profiles down to lock node: ${targetIp}`);

        const syncSuccess = await syncMutationToHardware(targetIp, `/api/save_settings?s=${encodeURIComponent(wifiSSID)}&p=${encodeURIComponent(wifiPass)}&pass=${HARDWARE_OTA_PASS}`);
        return sendJSON(res, 200, { status: "ok", hardwareSynced: syncSuccess });
      }

      if (pathname === '/api/unlock' && req.method === 'GET') {
        const accountId = query.accountId;
        const devRes = await dbPool.query('SELECT mac_address FROM devices WHERE account_id = $1 LIMIT 1', [accountId]);
        if (devRes.rows.length > 0) {
          const targetMac = devRes.rows[0].mac_address;
          unlockQueues[targetMac] = true; 
          unlockQueues['00:00:00:00:00:00'] = true;
          await dbPool.query('INSERT INTO system_events (mac_address, message) VALUES ($1, $2)', [targetMac, 'Zdalne wywołanie Mobile']);
          writeToLocalLogFile('API Control Command', `Dispatched remote unlock trigger down to: ${targetMac}`);
          setTimeout(() => { 
            unlockQueues[targetMac] = false; 
            unlockQueues['00:00:00:00:00:00'] = false;
          }, 15000); 
        }
        return sendJSON(res, 200, { status: "ok" });
      }

      if (pathname === '/api/toggle_learn' && req.method === 'GET') {
        const accountId = query.accountId;
        const devRes = await dbPool.query('SELECT mac_address, operational_mode FROM devices WHERE account_id = $1 LIMIT 1', [accountId]);
        if (devRes.rows.length > 0) {
          const targetMac = devRes.rows[0].mac_address;
          const nextMode = devRes.rows[0].operational_mode === 'Czuwanie' ? 'Uczenie' : 'Czuwanie';
          await dbPool.query('UPDATE devices SET operational_mode = $1 WHERE mac_address = $2', [nextMode, targetMac]);
          if (nextMode === 'Uczenie') {
            learningQueues[targetMac] = query.username ? decodeURIComponent(query.username) : 'Nowy Użytkownik';
          } else {
            delete learningQueues[targetMac];
          }
          writeToLocalLogFile('API Control Command', `Operational mode set to: ${nextMode} for: ${targetMac}`);
        }
        return sendJSON(res, 200, { status: "ok" });
      }

      if (pathname === '/api/hardware/log_button' && req.method === 'GET') {
        const ipLookup = await dbPool.query('SELECT mac_address FROM devices WHERE last_known_ip = $1', [cleanIp]);
        const targetMac = ipLookup.rows.length > 0 ? ipLookup.rows[0].mac_address : '00:00:00:00:00:00';
        
        await dbPool.query('INSERT INTO system_events (mac_address, message) VALUES ($1, $2)', [targetMac, 'Naciśnięto przycisk fizyczny']);
        writeToLocalLogFile('Hardware Handshake', `[Node: ${targetMac}] Local physical click recorded quietly.`);
        
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end("OK");
        return;
      }

      // 🌟 ENDPOINT DLA TELEFONU: SPRAWDZANIE NAJNOWSZEJ WERSJI (ZWRACA JSON)
      if (pathname === '/api/firmware/version' && req.method === 'GET') {
        const fwContext = getLatestFirmwareContext();
        return sendJSON(res, 200, { latestVersion: fwContext.version });
      }

      // 🌟 ENDPOINT DLA ARDUINO: STRUMIEŃ BINARNY PLIKU FIRMWARE (PULL OTA)
      if (pathname === '/api/firmware/latest' && req.method === 'GET') {
        const fwContext = getLatestFirmwareContext();
        
        if (!fwContext.filename) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('No firmware files available on server');
        }

        const filePath = path.join('/opt/smartlock-server/updates', fwContext.filename);
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          
          writeToLocalLogFile('OTA Stream Engine', `Streaming structural binary packet: ${fwContext.filename} (${stat.size} bytes) to lock node IP: ${cleanIp}`);
          
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': stat.size,
            'X-Firmware-Version': fwContext.version
          });

          const readStream = fs.createReadStream(filePath);
          return readStream.pipe(res);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('Firmware file target missing from filesystem');
        }
      }

      // =========================================================================
      // ⚡ HARDWARE CONNECTOR INTERFACES
      // =========================================================================

      if (pathname === '/api/device/provision' && req.method === 'POST') {
        const { mac, ownerId, currentIp, firmware } = body;
        await dbPool.query(
          `INSERT INTO devices (mac_address, account_id, last_known_ip, firmware_version)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (mac_address) DO UPDATE 
           SET last_known_ip = $3, firmware_version = $4, last_heartbeat = CURRENT_TIMESTAMP`,
          [mac, ownerId, currentIp, firmware]
        );
        return sendJSON(res, 200, { status: "paired" });
      }

      if ((pathname === '/api/hardware/poll' || pathname === '/api/poll' || pathname === '/poll') && req.method === 'GET') {
        let mac = query.mac;
        let currentHardwareVersion = '0.0.0';

        if (!mac) {
          const ipLookup = await dbPool.query('SELECT mac_address, firmware_version FROM devices WHERE last_known_ip = $1', [cleanIp]);
          if (ipLookup.rows.length > 0) {
            mac = ipLookup.rows[0].mac_address;
            currentHardwareVersion = ipLookup.rows[0].firmware_version || '0.0.0';
          } else {
            mac = '00:00:00:00:00:00';
          }
        } else {
          const devLookup = await dbPool.query('UPDATE devices SET last_heartbeat = CURRENT_TIMESTAMP, last_known_ip = $1 WHERE mac_address = $2 RETURNING firmware_version', [cleanIp, mac]);
          if (devLookup.rows.length > 0) {
            currentHardwareVersion = devLookup.rows[0].firmware_version || '0.0.0';
          }
        }

        const unlockAction = unlockQueues[mac] || unlockQueues['00:00:00:00:00:00'] || false;
        const isLearning = learningQueues[mac] ? true : false;

        if (unlockAction) {
          unlockQueues[mac] = false;
          unlockQueues['00:00:00:00:00:00'] = false;
          writeToLocalLogFile('Hardware Node Poll Pipeline', `Consumed unlock signal token packet down to hardware node: ${mac}`);
        }

        // 🌟 AUTOMATYCZNE PORÓWNANIE WERSJI W PĘTLI POLL
        const latestFw = getLatestFirmwareContext();
        const cleanCurrent = currentHardwareVersion.replace('v', '').trim();
        const cleanLatest = latestFw.version.trim();
        
        // Jeśli wersja na serwerze jest inna niż zaraportowana przez hardware – podnieś flagę ota
        const otaUpdateTrigger = (cleanLatest !== '0.0.0' && cleanCurrent !== cleanLatest);

        return sendJSON(res, 200, {
          unlock: unlockAction,
          learn: isLearning,
          username: learningQueues[mac] || '',
          ota: otaUpdateTrigger,              // Triggery dla Arduino R4 WiFi
          latest_version: latestFw.version    // Informacja dla mikrokontrolera o docelowej wersji
        });
      }

      if ((pathname === '/api/log' || pathname === '/log') && req.method === 'POST') {
        const rawTelemetryLogString = bodyStr.trim();
        const ipLookup = await dbPool.query('SELECT mac_address FROM devices WHERE last_known_ip = $1', [cleanIp]);
        const targetMac = ipLookup.rows.length > 0 ? ipLookup.rows[0].mac_address : '00:00:00:00:00:00';

        if (rawTelemetryLogString.length > 0) {
          await dbPool.query('INSERT INTO system_events (mac_address, message) VALUES ($1, $2)', [targetMac, rawTelemetryLogString]);
          writeToLocalLogFile('Hardware Ingest', `[Node: ${targetMac}] Telemetry: "${rawTelemetryLogString}"`);
        }
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end("OK");
        return;
      }

      if ((pathname === '/api/hardware/scan' || pathname === '/api/scan' || pathname === '/scan') && req.method === 'POST') {
        let mac = body.mac;
        let uid = body.uid;
        if (!mac) {
          const ipLookup = await dbPool.query('SELECT mac_address FROM devices WHERE last_known_ip = $1', [cleanIp]);
          mac = ipLookup.rows.length > 0 ? ipLookup.rows[0].mac_address : '00:00:00:00:00:00';
        }
        const credentialRes = await dbPool.query('SELECT holder_name, is_active FROM card_credentials WHERE mac_address = $1 AND card_uid = $2', [mac, uid]);
        if (credentialRes.rows.length > 0 && credentialRes.rows[0].is_active) {
          unlockQueues[mac] = true;
          await dbPool.query('INSERT INTO system_events (mac_address, message) VALUES ($1, $2)', [mac, `Otwarto: ${credentialRes.rows[0].holder_name}`]);
          writeToLocalLogFile('Access Granted', `[Node: ${mac}] Matched name description: ${credentialRes.rows[0].holder_name}`);
          return sendJSON(res, 200, { access: "granted" });
        } else {
          const nameLabel = credentialRes.rows.length > 0 ? credentialRes.rows[0].holder_name : 'Nieznany';
          await dbPool.query('INSERT INTO system_events (mac_address, message) VALUES ($1, $2)', [mac, `Odmowa: ${nameLabel} [${uid}]`]);
          writeToLocalLogFile('Access Denied', `[Node: ${mac}] Mismatch signature vector: ${uid}`);
          return sendJSON(res, 200, { access: "denied" });
        }
      }

      if ((pathname === '/api/hardware/register' || pathname === '/api/register' || pathname === '/register') && req.method === 'POST') {
        let mac = body.mac;
        let uid = body.uid;
        if (!mac) {
          const ipLookup = await dbPool.query('SELECT mac_address FROM devices WHERE last_known_ip = $1', [cleanIp]);
          mac = ipLookup.rows.length > 0 ? ipLookup.rows[0].mac_address : '00:00:00:00:00:00';
        }
        const pendingLabel = learningQueues[mac] || 'Nowy Użytkownik';
        await dbPool.query('INSERT INTO card_credentials (mac_address, card_uid, holder_name, is_active) VALUES ($1, $2, $3, true) ON CONFLICT (mac_address, card_uid) DO UPDATE SET holder_name = $3', [mac, uid, pendingLabel]);
        await dbPool.query('INSERT INTO system_events (mac_address, message) VALUES ($1, $2)', [mac, `Przypisano: ${pendingLabel} [${uid}]`]);
        writeToLocalLogFile('Hardware Registration', `[Node: ${mac}] Mapped card holder row to: ${pendingLabel} [${uid}]`);
        delete learningQueues[mac];
        return sendJSON(res, 200, { status: "registered" });
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

server.listen(3000, () => {
  console.log('⚡ Multi-Tenant SmartLock Engine live on port 3000. Writing local filesystem archives at /var/log/smartlock/');
  writeToLocalLogFile('Core Daemon', 'Platform backend environment daemon spun up successfully.');
});