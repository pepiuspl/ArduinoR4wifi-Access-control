#!/usr/bin/env bash
# Retencja logów serwera CTRLABLE Node = 90 dni (polityka prywatności §6, README §3.2).
# Uruchom RAZ na serwerze jako root:  bash ops/install-logrotate.sh
#   - /etc/logrotate.d/smartlock : smartlock_system.log rotowany codziennie, 90 kopii, gzip
#   - /etc/cron.daily/smartlock-logs : kasuje pliki dzienne w podkatalogach kategorii
#     (/var/log/smartlock/{entries,connections,updates,security,provisioning,mail}/YYYY-MM-DD.log)
#     starsze niż 90 dni — te i tak są dzielone po dacie, więc logrotate nie jest do nich potrzebny.
# server.js dopisuje linie przez fs.appendFile (bez trzymania otwartego deskryptora),
# więc zwykła rotacja z tworzeniem nowego pliku jest bezpieczna — bez copytruncate.
set -euo pipefail
LOGDIR="/var/log/smartlock"
DAYS="${SMARTLOCK_LOG_DAYS:-90}"

cat > /etc/logrotate.d/smartlock <<EOF
$LOGDIR/smartlock_system.log {
    daily
    rotate $DAYS
    compress
    delaycompress
    missingok
    notifempty
    dateext
    create 0640 root root
}
EOF

cat > /etc/cron.daily/smartlock-logs <<EOF
#!/bin/sh
# Kategorie logów dzielone po dacie — kasujemy starsze niż $DAYS dni.
find "$LOGDIR" -mindepth 2 -type f -name '*.log' -mtime +$DAYS -delete
find "$LOGDIR" -mindepth 2 -type f -name '*.log.gz' -mtime +$DAYS -delete
EOF
chmod 0755 /etc/cron.daily/smartlock-logs

logrotate -d /etc/logrotate.d/smartlock >/dev/null 2>&1 && echo "logrotate: konfiguracja poprawna" || echo "UWAGA: logrotate zgłosił błąd konfiguracji"
echo "Zainstalowano: /etc/logrotate.d/smartlock + /etc/cron.daily/smartlock-logs (retencja $DAYS dni)"
