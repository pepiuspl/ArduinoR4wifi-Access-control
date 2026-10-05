# CTRLABLE Access — firmware panelu zewnętrznego (ESP32-C3, OSDP PD)

Firmware płytki `CTRLABLE-Access-RS485` rev 0.1. Panel czyta kartę, PIN i sabotaż,
wysyła je do centralki magistralą RS-485 (OSDP, Secure Channel AES-128) i pokazuje
na ekranie to, co centralka każe pokazać.

**Panel nie podejmuje żadnej decyzji o otwarciu drzwi.** Rygiel jest wyłącznie
w centralce. Kto zdejmie panel ze ściany, ma cztery żyły z szyfrowanym protokołem,
a nie dostęp do zamka — to jest sedno przejścia z 19-żyłowego kabla na RS-485.

## Stan

- **Kompiluje się** (ESP32-C3, rdzeń Arduino 3.x): RAM 4,2%, Flash 32,0%.
- **Nie był uruchamiany na sprzęcie** — płytka nie jest jeszcze wyprodukowana.
- Nietestowane w praktyce: parowanie Secure Channel z centralką, zachowanie przy
  zerwanej magistrali, czasy odpowiedzi PD przy 115200 bps.

## Budowanie i wgrywanie — Arduino IDE

Szkic jest zwykłym szkicem Arduino: otwierasz **`panel-firmware.ino`**, pliki `.h/.cpp`
leżą obok i IDE kompiluje je automatycznie.

**1. Biblioteki.** Przez *Narzędzia → Zarządzaj bibliotekami* zainstaluj:

| biblioteka | po co |
|---|---|
| `MFRC522` (miguelbalboa) | czytnik kart |
| `Adafruit SH110X` + `Adafruit GFX Library` + `Adafruit BusIO` | ekran OLED |
| `Adafruit MCP23017 Arduino Library` | ekspander klawiatury |

**LibOSDP nie ma w menedżerze bibliotek** (jest tylko w formacie PlatformIO). Instaluje ją
skrypt z tego katalogu — układa źródła w formacie biblioteki Arduino i dokłada brakujący
`library.properties`:

```bash
python tools/make_arduino_lib.py
```

Domyślnie instaluje do `Dokumenty/Arduino/libraries/LibOSDP`. Po tym trzeba zrestartować IDE.
Skrypt działa też bez PlatformIO — jeśli nie znajdzie lokalnej kopii, klonuje repozytorium
(potrzebny `git`).

**2. Ustawienia płytki** (*Narzędzia*):

| pozycja | wartość |
|---|---|
| Board | **ESP32C3 Dev Module** |
| USB CDC On Boot | **Enabled** — konsola idzie po natywnym USB (pady SV1) |
| Flash Size | 4 MB |
| Partition Scheme | Default 4MB with spiffs |
| Upload Speed | 921600 |

**3. Wgrywanie.** Podłącz pady `SV1`: D+, D−, 3V3, GND. Przy pierwszym wgraniu zewrzyj
pad **BOOT** do masy, podaj zasilanie, puść BOOT. Kolejne wgrania idą już bez zwierania.

### PlatformIO (opcjonalnie)

`platformio.ini` w tym katalogu buduje **te same pliki** (`src_dir = .`), więc nie ma drugiej
kopii kodu. Przydaje się do kompilacji z linii poleceń i w CI:

```bash
pio run                 # kompilacja
pio run -t upload       # wgranie
pio device monitor      # konsola 115200
```

Stan: kompiluje się, **RAM 4,2%, Flash 32,0%** (ESP32-C3, 4 MB).

## Jak to działa

**Do centralki (zdarzenia OSDP):**
- `CARDREAD` — UID karty w formacie RAW (4/7/10 bajtów),
- `KEYPRESS` — pojedynczy klawisz `0-9`, `*`, `#` (jedno zdarzenie na naciśnięcie),
- `STATUS/LOCAL` — sabotaż obudowy (mikrostyk NC na GPB0 ekspandera).

**Z centralki (komendy OSDP):**
- `TEXT` — napis na ekranie; `control_code` 3/4 = czasowy (`temp_time` w sekundach),
  1/2 = do odwołania. Tak przychodzą komunikaty typu `POZA HARMONOGRAMEM`,
- `BUZZER` — wzorzec pikania (`on_count`/`off_count` w jednostkach 100 ms),
- `LED` — przyjmowana i ignorowana (panel nie ma diod, są w centralce),
- `KEYSET` — wgranie klucza Secure Channel (patrz niżej),
- `OUTPUT` — **odrzucana**: panel nie ma czym sterować ryglem i nie powinien mieć.

**Lokalnie, bez pytania centralki:** gwiazdki przy wpisywaniu PIN-u (natychmiastowa
reakcja na klawisz), ekran spoczynkowy, stan magistrali w stopce, alarm sabotażu.
Treści PIN-u panel nie zna i nie buforuje — każdy klawisz leci osobno do centralki.

## Klucz Secure Channel

Panel bez klucza w NVS startuje w **install mode** (klucz domyślny z normy) —
w tym stanie centralka może wgrać mu własny klucz komendą `KEYSET`. Po zapisaniu
klucza panel przechodzi w tryb **wymuszonego szyfrowania** (`OSDP_FLAG_ENFORCE_SECURE`)
i nie rozmawia już otwartym tekstem.

Klucz generuje centralka (16 bajtów z `esp_fill_random`), trzyma go w swoim NVS
i wgrywa przy pierwszym połączeniu. Wymiana panelu na nowy = nowy panel startuje
w install mode i dostaje ten sam klucz automatycznie.

> **Niezrobione:** panel nie ma włączonego Secure Boot ani Flash Encryption.
> Bez tego klucz w NVS da się odczytać po wymontowaniu układu. Włączenie tego
> to osobna robota (eFuse, podpisywanie obrazów) i osobna decyzja — dopóki jej
> nie ma, klucz chroni transmisję, ale nie chroni sam siebie.

## Konfiguracja bez rekompilacji

W NVS (namespace `ctrlable`):

| klucz | typ | domyślnie | znaczenie |
|---|---|---|---|
| `pd_addr` | int | 101 | adres PD na magistrali |
| `pd_baud` | uint | 115200 | prędkość (musi zgadzać się z centralką) |
| `scbk` | bytes[16] | — | klucz Secure Channel (wgrywa centralka) |

## Czego tu nie ma

- **BLE** (otwieranie telefonem) — moduł ma radio, ale firmware go nie używa,
- **OTA panelu** — aktualizacja musi iść przez centralkę (`FILE_TX` w OSDP);
  dziś wgrywa się tylko przez USB,
- obsługi czytnika **PN532/PN5180** — kod zakłada MFRC522; przy zmianie czytnika
  zmienia się `src/io.cpp` (i dochodzi 5 V dla PN5180),
- **testów** — nie ma sprzętu, na którym można by je uruchomić.
