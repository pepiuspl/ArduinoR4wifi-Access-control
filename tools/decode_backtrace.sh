#!/usr/bin/env bash
# Dekoduje ślad stosu z linii bootu centralki (README §5.13) na plik:linia.
#   bash tools/decode_backtrace.sh lock_v3.2.1.elf 0x400d1234,0x400d5678 [0x...]
# Plik .elf pobierz z wydania GitHub (ta sama wersja co firmware, który się wywalił).
# Adresy możesz podać po przecinku (jak w logu: bt=0x..,0x..) albo po spacji.
set -euo pipefail
ELF="${1:?użycie: decode_backtrace.sh <plik.elf> <adresy>}"; shift
ADDRS=$(echo "$*" | tr ',' ' ')
A2L=""
for c in \
  "$LOCALAPPDATA/Arduino15/packages/esp32/tools/esp-x32"/*/bin/xtensa-esp32-elf-addr2line.exe \
  "$HOME/.arduino15/packages/esp32/tools/esp-x32"/*/bin/xtensa-esp32-elf-addr2line \
  "$HOME/Library/Arduino15/packages/esp32/tools/esp-x32"/*/bin/xtensa-esp32-elf-addr2line \
  "$(command -v xtensa-esp32-elf-addr2line 2>/dev/null || true)"; do
  [ -n "$c" ] && [ -x "$c" ] && { A2L="$c"; break; }
done
[ -n "$A2L" ] || { echo "Nie znaleziono xtensa-esp32-elf-addr2line — zainstaluj rdzeń esp32 w Arduino IDE." >&2; exit 1; }
echo "ELF: $ELF"
"$A2L" -pfiaC -e "$ELF" $ADDRS
