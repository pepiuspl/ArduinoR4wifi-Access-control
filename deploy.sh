#!/usr/bin/env bash
# =============================================================================
# Deploy z laptopa na backend przez LAN — server.js + app.js.
# Bezpieczne: używa Twojego istniejącego SSH po sieci lokalnej (192.168.0.199),
# NIC nie wystawia na internet (żaden port-forward, żaden klucz w chmurze).
# Robi App.js dla Metro (wielkość liter!) i restartuje oba procesy pm2.
#
# Użycie:  ./deploy.sh
# Nadpisywalne env-em: DEPLOY_SERVER=root@1.2.3.4 DEPLOY_DEST=/opt/... ./deploy.sh
# =============================================================================
set -euo pipefail

SERVER="${DEPLOY_SERVER:-root@192.168.0.199}"
DEST="${DEPLOY_DEST:-/opt/smartlock-server}"

cd "$(dirname "$0")"

echo "→ Wysyłam server.js + app.js na ${SERVER}:${DEST}"
scp Server_app/server.js Server_app/app.js "${SERVER}:${DEST}/"

echo "→ App.js (Metro) + restart pm2 (ctrlable-server, ctrlable-app)"
ssh "${SERVER}" "cd '${DEST}' && cp app.js App.js && /usr/local/bin/pm2 restart ctrlable-server ctrlable-app && /usr/local/bin/pm2 save"

echo "✅ Deploy zakończony. Sprawdź: ssh ${SERVER} 'pm2 logs ctrlable-server --lines 15 --nostream'"
