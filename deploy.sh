#!/usr/bin/env bash
# =============================================================================
# Deploy z laptopa na backend przez LAN — server.js + licensekey.js + app.js.
# Bezpieczne: używa Twojego istniejącego SSH po sieci lokalnej, NIC nie wystawia
# na internet. Ścieżki docelowe RÓŻNE:
#   server.js     -> /opt/smartlock-server/server.js      (backend, pm2 ctrlable-server)
#   tools/licensekey.js -> /opt/smartlock-server/licensekey.js  (generator kodów online, odpalany na serwerze)
#   app.js        -> /opt/smartlock-server/app/App.js     (Metro/Expo, pm2 ctrlable-app)
# Metro ładuje App.js (wielka litera!) z podkatalogu app/.
#
# HASŁO PYTANE RAZ — na każdym systemie: wszystkie pliki jadą JEDNYM połączeniem
# (tar przez stdin ssh), a rozpakowanie i restart pm2 wykonuje ta sama sesja.
# Wcześniejsze podejście (ControlMaster) nie działało w Git Bash na Windows.
#
# Zanim produkcyjny server.js zostanie podmieniony, serwer sprawdza jego składnię
# (node --check) — błąd = przerwanie BEZ dotykania działającej wersji.
#
# Chcesz całkiem bez hasła? Jednorazowo:  ssh-copy-id root@192.168.0.199
#
# Użycie:  ./deploy.sh        (na Windows: bash deploy.sh)
# Nadpisywalne env-em: DEPLOY_SERVER=root@1.2.3.4 DEPLOY_DEST=/opt/... ./deploy.sh
# =============================================================================
set -euo pipefail

SERVER="${DEPLOY_SERVER:-root@192.168.0.199}"
DEST="${DEPLOY_DEST:-/opt/smartlock-server}"

cd "$(dirname "$0")"

for f in Server_app/server.js tools/licensekey.js Server_app/app.js; do
  [ -f "$f" ] || { echo "❌ Brak pliku $f"; exit 1; }
done

# Skrypt wykonywany NA SERWERZE w jednej sesji. Heredoc w apostrofach = nic nie jest
# rozwijane lokalnie; DEST przekazujemy jako pierwszy argument (bash -s -- "$DEST").
read -r -d '' REMOTE_SCRIPT <<'REMOTE' || true
set -e
DEST="$1"
T=$(mktemp -d /tmp/ctrlable-deploy.XXXXXX)
trap 'rm -rf "$T"' EXIT
tar xzf - -C "$T"

NODE=$(command -v node || ls /usr/local/bin/node /usr/bin/node 2>/dev/null | head -1)
echo "→ node --check server.js (przed podmianą)"
"$NODE" --check "$T/server.js"
# Nawracający błąd z README §3.4: licznik rate-limitu bez ++ = brak limitów.
grep -q 'store\[ip\].count++' "$T/server.js" || { echo "❌ checkRateLimit bez count++ (README §3.4) — przerywam."; exit 1; }

echo "→ podmiana plików"
mv -f "$T/server.js"     "$DEST/server.js"
mv -f "$T/licensekey.js" "$DEST/licensekey.js"
mv -f "$T/app.js"        "$DEST/app/App.js"

echo "→ restart pm2 (ctrlable-server, ctrlable-app)"
/usr/local/bin/pm2 restart ctrlable-server ctrlable-app --update-env && /usr/local/bin/pm2 save
sleep 3
echo "→ ostatnie linie logu backendu:"
/usr/local/bin/pm2 logs ctrlable-server --lines 8 --nostream 2>/dev/null | tail -8 || true
echo "→ migracje:"
grep Migration /var/log/smartlock/smartlock_system.log 2>/dev/null | tail -1 || true
REMOTE

echo "→ Wysyłanie server.js, licensekey.js, app.js do ${SERVER}:${DEST} (jedno połączenie, hasło raz)..."
# tar idzie stdin-em, więc skrypt zdalny nie może iść tym samym kanałem: przekazujemy
# go w base64 w linii poleceń (same [A-Za-z0-9+/=] — niezależnie od powłoki roota).
REMOTE_B64=$(printf '%s' "$REMOTE_SCRIPT" | base64 | tr -d '\n')
tar czf - -C Server_app server.js app.js -C ../tools licensekey.js \
  | ssh "${SERVER}" "bash -c \"\$(echo ${REMOTE_B64} | base64 -d)\" -- '${DEST}'"

echo "✅ Deploy zakończony."
echo "   Jeśli backend nie wstał: ssh ${SERVER} 'pm2 logs ctrlable-server --lines 30 --nostream'  (brak JWT_SECRET w .env = celowe zatrzymanie, README §7.4)"
