#!/usr/bin/env bash
# =============================================================================
# Deploy z laptopa na backend przez LAN — server.js + app.js.
# Bezpieczne: używa Twojego istniejącego SSH po sieci lokalnej, NIC nie wystawia
# na internet. Ścieżki docelowe RÓŻNE:
#   server.js -> /opt/smartlock-server/server.js        (backend, pm2 ctrlable-server)
#   app.js    -> /opt/smartlock-server/app/App.js       (Metro/Expo, pm2 ctrlable-app)
# Metro ładuje App.js (wielka litera!) z podkatalogu app/.
#
# Użycie:  ./deploy.sh
# Nadpisywalne env-em: DEPLOY_SERVER=root@1.2.3.4 DEPLOY_DEST=/opt/... ./deploy.sh
# =============================================================================
set -euo pipefail

SERVER="${DEPLOY_SERVER:-root@192.168.0.199}"
DEST="${DEPLOY_DEST:-/opt/smartlock-server}"

cd "$(dirname "$0")"

echo "→ server.js    → ${SERVER}:${DEST}/server.js"
scp Server_app/server.js "${SERVER}:${DEST}/server.js"

echo "→ licensekey.js → ${SERVER}:${DEST}/licensekey.js  (generator kodów, uruchamiany na serwerze)"
scp Server_app/licensekey.js "${SERVER}:${DEST}/licensekey.js"

echo "→ app.js       → ${SERVER}:${DEST}/app/App.js  (entry Metro)"
scp Server_app/app.js "${SERVER}:${DEST}/app/App.js"

echo "→ restart pm2 (ctrlable-server, ctrlable-app)"
ssh "${SERVER}" "/usr/local/bin/pm2 restart ctrlable-server ctrlable-app && /usr/local/bin/pm2 save"

echo "✅ Deploy zakończony."
echo "   Sprawdź: ssh ${SERVER} 'grep -c \"Pakiet i licencja\" ${DEST}/app/App.js'  (ma być 1)"
