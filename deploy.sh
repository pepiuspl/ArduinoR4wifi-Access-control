#!/usr/bin/env bash
# =============================================================================
# Deploy z laptopa na backend przez LAN — server.js + licensekey.js + app.js.
# Bezpieczne: używa Twojego istniejącego SSH po sieci lokalnej, NIC nie wystawia
# na internet. Ścieżki docelowe RÓŻNE:
#   server.js     -> /opt/smartlock-server/server.js      (backend, pm2 ctrlable-server)
#   licensekey.js -> /opt/smartlock-server/licensekey.js  (generator kodów, odpalany na serwerze)
#   app.js        -> /opt/smartlock-server/app/App.js     (Metro/Expo, pm2 ctrlable-app)
# Metro ładuje App.js (wielka litera!) z podkatalogu app/.
#
# HASŁO PYTANE RAZ: skrypt zestawia JEDNO połączenie master (ControlMaster) i
# wszystkie kolejne scp/ssh jadą przez ten sam tunel. Bez tego każda z 4 operacji
# pytała osobno. Gniazdo kasuje się automatycznie na wyjściu (także przy błędzie).
#
# Chcesz całkiem bez hasła? Jednorazowo:  ssh-copy-id root@192.168.0.199
#
# Użycie:  ./deploy.sh
# Nadpisywalne env-em: DEPLOY_SERVER=root@1.2.3.4 DEPLOY_DEST=/opt/... ./deploy.sh
# =============================================================================
set -euo pipefail

SERVER="${DEPLOY_SERVER:-root@192.168.0.199}"
DEST="${DEPLOY_DEST:-/opt/smartlock-server}"

cd "$(dirname "$0")"

# --- Jedno wspólne połączenie SSH -------------------------------------------
CTRL_SOCKET="${TMPDIR:-/tmp}/ctrlable-deploy-$$.sock"
SSH_OPTS=(-o "ControlMaster=auto" -o "ControlPath=${CTRL_SOCKET}" -o "ControlPersist=120")

cleanup() {
  # Zamknij master, żeby nie zostawiać wiszącego gniazda ani sesji.
  ssh -o "ControlPath=${CTRL_SOCKET}" -O exit "${SERVER}" 2>/dev/null || true
}
trap cleanup EXIT

echo "→ Łączenie z ${SERVER} (hasło tylko RAZ)..."
ssh "${SSH_OPTS[@]}" "${SERVER}" true

echo "→ server.js     → ${SERVER}:${DEST}/server.js"
scp "${SSH_OPTS[@]}" Server_app/server.js "${SERVER}:${DEST}/server.js"

echo "→ licensekey.js → ${SERVER}:${DEST}/licensekey.js  (generator kodów, uruchamiany na serwerze)"
scp "${SSH_OPTS[@]}" Server_app/licensekey.js "${SERVER}:${DEST}/licensekey.js"

echo "→ app.js        → ${SERVER}:${DEST}/app/App.js  (entry Metro)"
scp "${SSH_OPTS[@]}" Server_app/app.js "${SERVER}:${DEST}/app/App.js"

echo "→ restart pm2 (ctrlable-server, ctrlable-app)"
ssh "${SSH_OPTS[@]}" "${SERVER}" "/usr/local/bin/pm2 restart ctrlable-server ctrlable-app && /usr/local/bin/pm2 save"

echo "✅ Deploy zakończony."
echo "   Sprawdź: ssh ${SERVER} 'grep -c \"Pakiet i licencja\" ${DEST}/app/App.js'  (ma być 1)"
