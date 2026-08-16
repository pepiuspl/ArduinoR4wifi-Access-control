#!/bin/bash
# =============================================================================
# CTRLABLE — healthcheck publicznego wejścia (node.ctrlable.pl -> NPM -> backend).
# Alarmuje mailem TYLKO przy ZMIANIE stanu (UP<->DOWN), żeby nie spamować.
# Łapie dokładnie awarię z 2026-08-16: NPM/sieć Proxy padły, backend żył, a nikt
# nie wiedział. Uruchamiany z crona co 2–3 min NA BACKENDZIE (VM, która była UP).
# Dla pełnych awarii (cały serwer down) dołóż zewnętrzny monitor (UptimeRobot).
# =============================================================================
URL="${HC_URL:-https://node.ctrlable.pl/api/data}"
ALERT_TO="${HC_ALERT_TO:-pepiuspl@gmail.com}"
FROM="${HC_FROM:-monitor@ctrlable.pl}"
STATE_FILE="${HC_STATE_FILE:-/var/lib/ctrlable/health.state}"

mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null

# 401/200 = zdrowo (backend+proxy odpowiadają; 401 bo brak auth). Reszta = problem.
# 000 = brak odpowiedzi (TLS/TCP/DNS padły) — to był objaw awarii.
code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$URL" 2>/dev/null)"
if [ "$code" = "401" ] || [ "$code" = "200" ]; then
  new="UP"
else
  new="DOWN(HTTP $code)"
fi

old="$(cat "$STATE_FILE" 2>/dev/null)"
if [ "$new" != "$old" ]; then
  echo "$new" > "$STATE_FILE"
  # Nie wysyłaj maila przy pierwszym uruchomieniu (old puste) — tylko zapisz stan.
  if [ -n "$old" ]; then
    subj="[CTRLABLE monitor] $URL: $old -> $new"
    body="Zmiana stanu: $old -> $new
URL:  $URL
HTTP: $code
Host: $(hostname)
Czas: $(date '+%Y-%m-%d %H:%M:%S %Z')"
    printf 'From: %s\nTo: %s\nSubject: %s\n\n%s\n' "$FROM" "$ALERT_TO" "$subj" "$body" | sendmail -t 2>/dev/null \
      || printf '%s\n' "$body" | mail -s "$subj" "$ALERT_TO" 2>/dev/null
  fi
fi
