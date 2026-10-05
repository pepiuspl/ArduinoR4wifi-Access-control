# -*- coding: utf-8 -*-
"""
Buduje z LibOSDP normalną bibliotekę Arduino i instaluje ją w katalogu bibliotek IDE.

Po co: LibOSDP ma tylko `library.json` (PlatformIO) i nie ma `library.properties`,
więc Arduino IDE ani arduino-cli jej nie widzą. Ten skrypt układa źródła w formacie
biblioteki Arduino 1.5+ (wszystko pod `src/`, ścieżka include = `src/`) i dokłada
opis, którego brakuje.

Użycie:
    python tools/make_arduino_lib.py [katalog-zrodel-libosdp] [katalog-docelowy]

Bez argumentów bierze kopię pobraną przez PlatformIO (`.pio/libdeps/panel/LibOSDP`)
albo klonuje repozytorium do katalogu tymczasowego, a instaluje do
`Dokumenty/Arduino/libraries/LibOSDP`.

Co robi ze źródłami (odwzorowanie tego, co robi `library.json`):
  * bierze `src/*.c` BEZ `osdp_diag.c` i `osdp_trs.c` (diagnostyka i tryb transparentny
    ciągną zależności, których na mikrokontrolerze nie używamy),
  * z `src/crypto/` bierze tylko `tinyaes*` (mbedTLS/OpenSSL są dla dużych systemów),
  * z `utils/` bierze siedem modułów wymaganych przez bibliotekę,
  * dokłada `platformio/platformio.cpp` — to warstwa czasu (millis()) dla Arduino,
  * wstawia `#define __BARE_METAL__` do nagłówków `utils/utils.h`, `utils/assert.h`
    i `osdp_config.h`. W PlatformIO ta definicja jest podawana flagą kompilatora,
    a Arduino IDE nie ma mechanizmu flag per biblioteka — więc musi wejść w nagłówki.
"""
import io, os, re, shutil, subprocess, sys, tempfile

REPO = "https://github.com/goToMain/libosdp.git"
SRC_SKIP = {"osdp_diag.c", "osdp_trs.c"}
CRYPTO_KEEP = {"tinyaes.c", "tinyaes_src.c", "tinyaes_src.h"}
UTILS_C = ["disjoint_set.c", "list.c", "logger.c", "queue.c", "slab.c", "utils.c", "crc16.c"]
DEFINE_INTO = ["utils/utils.h", "utils/assert.h", "osdp_config.h"]

PROPS = """name=LibOSDP
version=4.0.0-dev
author=Siddharth Chandrasekaran <sidcha.dev@gmail.com>
maintainer=CTRLABLE (opakowanie dla Arduino)
sentence=Open Supervised Device Protocol (OSDP) - CP i PD z Secure Channel.
paragraph=Biblioteka LibOSDP (Apache-2.0) przepakowana do formatu Arduino skryptem panel-firmware/tools/make_arduino_lib.py. Nie edytuj recznie - przy aktualizacji uruchom skrypt ponownie.
category=Communication
url=https://github.com/goToMain/libosdp
architectures=esp32
"""

DEFINE_BLOCK = """/* Dodane przez CTRLABLE/make_arduino_lib.py: w PlatformIO ta definicja idzie
 * flaga -D __BARE_METAL__; Arduino IDE nie ma flag per biblioteka. */
#ifndef __BARE_METAL__
#define __BARE_METAL__ 1
#endif
"""


def zrodla(arg):
    if arg and os.path.isdir(arg):
        return arg, False
    tu = os.path.dirname(os.path.abspath(__file__))
    pio = os.path.join(tu, "..", ".pio", "libdeps", "panel", "LibOSDP")
    if os.path.isdir(pio):
        return os.path.normpath(pio), False
    tmp = os.path.join(tempfile.gettempdir(), "libosdp-src")
    if not os.path.isdir(tmp):
        print("klonuje %s ..." % REPO)
        r = subprocess.run(["git", "clone", "--depth", "1", "--recurse-submodules", REPO, tmp],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise SystemExit("git clone nie powiodl sie:\n" + (r.stderr or r.stdout))
    return tmp, True


def kopiuj(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)


def main():
    arg_src = sys.argv[1] if len(sys.argv) > 1 else None
    dom = os.path.join(os.path.expanduser("~"), "Documents", "Arduino", "libraries", "LibOSDP")
    cel = sys.argv[2] if len(sys.argv) > 2 else dom

    zr, _ = zrodla(arg_src)
    print("zrodla:  %s" % zr)
    print("instaluje do: %s" % cel)
    if not os.path.isdir(os.path.join(zr, "utils", "src")):
        raise SystemExit("brak katalogu utils/src — sklonuj repozytorium z --recurse-submodules")

    if os.path.isdir(cel):
        shutil.rmtree(cel)
    s = os.path.join(cel, "src")
    os.makedirs(s)

    n = 0
    # publiczne naglowki + konfiguracja
    for f in ("osdp.h", "osdp.hpp", "osdp_export.h"):
        kopiuj(os.path.join(zr, "include", f), os.path.join(s, f)); n += 1
    kopiuj(os.path.join(zr, "platformio", "osdp_config.h"), os.path.join(s, "osdp_config.h")); n += 1
    # rdzen biblioteki
    for f in sorted(os.listdir(os.path.join(zr, "src"))):
        if f in SRC_SKIP or not f.endswith((".c", ".h")):
            continue
        kopiuj(os.path.join(zr, "src", f), os.path.join(s, f)); n += 1
    for f in sorted(CRYPTO_KEEP):
        kopiuj(os.path.join(zr, "src", "crypto", f), os.path.join(s, "crypto", f)); n += 1
    # utils: naglowki pod utils/, zrodla obok nich
    for f in sorted(os.listdir(os.path.join(zr, "utils", "include", "utils"))):
        kopiuj(os.path.join(zr, "utils", "include", "utils", f), os.path.join(s, "utils", f)); n += 1
    for f in UTILS_C:
        kopiuj(os.path.join(zr, "utils", "src", f), os.path.join(s, "utils", f)); n += 1
    # warstwa Arduino (millis)
    kopiuj(os.path.join(zr, "platformio", "platformio.cpp"), os.path.join(s, "arduino_glue.cpp")); n += 1
    for f in ("LICENSE", "README.md"):
        if os.path.exists(os.path.join(zr, f)):
            kopiuj(os.path.join(zr, f), os.path.join(cel, f))

    # definicja, ktora w PlatformIO idzie flaga kompilatora
    for rel in DEFINE_INTO:
        p = os.path.join(s, rel.replace("/", os.sep))
        t = io.open(p, encoding="utf-8", errors="replace").read()
        if "__BARE_METAL__ 1" not in t:
            io.open(p, "w", encoding="utf-8", newline="\n").write(DEFINE_BLOCK + t)

    io.open(os.path.join(cel, "library.properties"), "w", encoding="utf-8", newline="\n").write(PROPS)
    print("gotowe: %d plikow zrodlowych + library.properties" % n)
    print("Arduino IDE zobaczy biblioteke po restarcie (Szkic -> Dolacz biblioteke -> LibOSDP).")


if __name__ == "__main__":
    main()
