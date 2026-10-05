# CTRLABLE Node — oprogramowanie osób trzecich

Firmware `access_control.ino` jest **zamkniętym oprogramowaniem CTRLABLE**. Korzysta z poniższych
komponentów osób trzecich. Licencje zweryfikowano na plikach dystrybucyjnych 23.09.2026.

| Komponent | Wersja | Licencja | Obowiązek |
|---|---|---|---|
| **arduino-esp32** (rdzeń: `cores/esp32`, `WiFi`, `Wire`, `SPI`, `EEPROM`, `Preferences`, `Update`, `LittleFS`, `ArduinoOTA`) | 3.3.11 | **GNU LGPL 2.1 or later** | nota + tekst licencji + możliwość relinkowania |
| Adafruit GFX Library | 1.12.6 | BSD 3-clause | nota o prawach autorskich |
| Adafruit SH110X | 2.1.14 | BSD | nota o prawach autorskich |
| Adafruit BusIO | 1.17.4 | MIT | nota o prawach autorskich |
| MFRC522 (miguelbalboa/rfid) | 1.4.12 | Unlicense (domena publiczna) | brak |
| NTPClient | 3.2.1 | MIT | nota o prawach autorskich |
| mbedTLS (w ESP-IDF pod rdzeniem) | z rdzenia 3.3.11 | Apache 2.0 | nota o prawach autorskich |

> **NTPClient** — dystrybuowana paczka 3.2.1 nie zawiera pliku licencji; licencję ustalono
> w repozytorium źródłowym `arduino-libraries/NTPClient` (`LICENSE.txt`): **MIT**,
> "Copyright (c) Fabrice Weinberg, Arduino SA". Do noty o prawach autorskich wpisać tę formułę.

### Weryfikacja integralności rdzenia (23.09.2026)
Archiwum `esp32-core-3.3.11.zip` z cache'u Arduino ma SHA-256
`a18203f2429f5551ec929b80e8129e439df7a3a009b536b305f00b4a1f1bbb62` — **zgodne z indeksem
Espressif**. Porównanie 2052 plików archiwum z zainstalowanym drzewem
`packages/esp32/hardware/esp32/3.3.11`: **0 plików zmienionych, 0 brakujących**; jedyny plik
nadmiarowy to `installed.json` generowany przez IDE (nie jest częścią biblioteki).

**Wniosek: biblioteka objęta LGPL nie została zmodyfikowana.** Oświadczenie na stronie
`ctrlable.pl/licencje` jest zgodne z prawdą, a obowiązek sprowadza się do noty, tekstu licencji
i oferty relinkowania — bez udostępniania jakichkolwiek źródeł CTRLABLE.
Skrypt weryfikacyjny warto powtórzyć przy każdej zmianie wersji rdzenia.

---

## 1. Nota do instrukcji obsługi (gotowa do wklejenia)

> **Oprogramowanie open source**
>
> Urządzenie CTRLABLE Node zawiera oprogramowanie osób trzecich, w tym bibliotekę
> **arduino-esp32 w wersji 3.3.11** (© Arduino S.r.l. i współautorzy), rozpowszechnianą na
> warunkach **GNU Lesser General Public License w wersji 2.1 lub późniejszej**.
>
> Pełny tekst licencji, wykaz wszystkich komponentów wraz z ich licencjami oraz
> niezmodyfikowany kod źródłowy biblioteki są dostępne pod adresem:
> **https://ctrlable.pl/licencje**
>
> Przez okres **3 lat od daty zakupu** udostępnimy na żądanie, na nośniku lub do pobrania,
> materiały umożliwiające ponowne zlinkowanie oprogramowania urządzenia z samodzielnie
> zmodyfikowaną wersją biblioteki objętej LGPL: kod obiektowy części własnej, wersję i
> konfigurację rdzenia oraz instrukcję linkowania. Zgłoszenia: **info@ctrlable.pl**.
>
> Niniejsze oprogramowanie osób trzecich rozpowszechniane jest bez jakiejkolwiek gwarancji,
> w zakresie dozwolonym przez prawo właściwe dla danej licencji.

---

## 2. Zawartość podstrony `ctrlable.pl/licencje`

Na stronie muszą znaleźć się:

1. Tabela komponentów z wersjami i licencjami (jak wyżej).
2. **Pełny tekst GNU LGPL 2.1** — plik `LGPL-2.1.txt` do pobrania i podlinkowany.
3. Pełne teksty licencji BSD / MIT / Unlicense (krótkie, można wkleić wprost na stronie).
4. Link do niezmodyfikowanych źródeł rdzenia: `https://github.com/espressif/arduino-esp32`
   ze wskazaniem **tagu 3.3.11**.
5. Oświadczenie: *„Biblioteki objęte LGPL nie zostały zmodyfikowane przez CTRLABLE."*
   — potwierdzone porównaniem 2052 plików z oryginalnym archiwum (patrz sekcja weryfikacji wyżej).
6. Adres kontaktowy do żądania materiałów relinkujących oraz informacja o 3-letnim terminie.

Podstrona ma być **stała** — nie w regulaminie, nie w aktualnościach. Link w stopce serwisu.

---

## 3. Materiały do relinkowania (przygotować raz, trzymać w archiwum)

Dla każdej wydanej wersji firmware zachować:

- `access_control.ino.elf` oraz katalog build z plikami `.o` sketcha i `.a` rdzenia,
- dokładną wersję rdzenia (3.3.11), wersje bibliotek, `platform.txt` / flagi kompilacji,
- użyty skrypt linkera i pełną linię polecenia linkera,
- krótkie `JAK_ZLINKOWAC.txt` opisujące procedurę.

To wystarcza, by spełnić §6 LGPL 2.1 **bez ujawniania kodu źródłowego części własnej**.

---

## 4. Uwaga do regulaminu / EULA

Jeżeli regulamin sprzedaży albo licencja użytkownika końcowego zawiera zakaz dekompilacji,
inżynierii wstecznej lub modyfikacji oprogramowania — **dodać wyjątek**:

> Powyższe ograniczenia nie mają zastosowania w zakresie, w jakim są sprzeczne z warunkami
> licencji oprogramowania osób trzecich zawartego w produkcie, w szczególności z GNU LGPL 2.1;
> w tym zakresie modyfikowanie i badanie działania takich komponentów jest dozwolone.

---

## 5. Kwestia otwarta: podpisane OTA a relinkowanie

Firmware weryfikuje podpis ECDSA P-256 aktualizacji (`FIRMWARE_PUBKEY_PEM`), więc samodzielnie
zlinkowany obraz **nie zostanie przyjęty przez urządzenie**. LGPL 2.1 — w odróżnieniu od GPLv3 —
nie zawiera klauzuli antytivoizacyjnej, więc stanowisko jest obronne, ale **przed pierwszą
sprzedażą w UE warto potwierdzić to u prawnika**. Wyjście alternatywne: migracja warstwy
sprzętowej na **ESP-IDF (Apache 2.0)**, która usuwa zobowiązania LGPL w całości.

---

## 6. Znak towarowy

Nazwa **„Arduino"** i logo Arduino to zastrzeżone znaki towarowe. Nie wolno ich używać
w nazwie produktu, na obudowie, opakowaniu ani w materiałach sprzedażowych. Wzmianka opisowa
o historii projektu („prototyp powstał na Arduino") jest dozwolona jako podanie faktu.

*Dokument przygotowany 23.09.2026. Nie stanowi porady prawnej.*
