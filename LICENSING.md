# CTRLABLE Node — Model limitów i licencji

**Wersja robocza — 13 sierpnia 2026, zaktualizowana 9 września 2026 (§3.3, §3.4, darmowy poziom = 2+2 i 2 adminów).** Liczby oznaczone *(prowizorycznie)* wymagają potwierdzenia:
ceny — decyzja biznesowa; sufit sprzętowy — walidacja na urządzeniu (bench‑test RAM/czasu skanu).

---

## 1. Zasada nadrzędna: dwie niezależne osie limitów

Limity biorą się z **dwóch różnych źródeł**, których nie wolno mieszać:

| Oś | Źródło | Kto pilnuje | Czy sprzedawane |
|---|---|---|---|
| **Sprzętowa** | fizyka urządzenia (flash, RAM, wydajność skanu) | firmware (centralka) | **nie** — to stała możliwość sprzętu |
| **Licencyjna** | pakiet wykupiony przez klienta | serwer (konto) | **tak** — to oferta handlowa |

**Efektywny limit = min(limit licencji, sufit sprzętowy).** Ponieważ sufit sprzętowy (~500) jest wyżej niż najwyższy pakiet, w praktyce **wiąże licencja** — sprzedaż, nie sprzęt.

**Offline = tryb odporności, nie osobny limit ani osobny produkt.** Wszystkie poświadczenia konta (do limitu pakietu) są synchronizowane lokalnie do centralki i działają natychmiast — także przy zaniku łącza. Darmowy poziom to pakiet **„Bez licencji" (2+2, 2 adminów), również online i bezterminowy** — nie ma „taniego offline", którym klient omija opłatę.

---

## 1a. Dwa tryby inicjalizacji

Klient wybiera przy uruchomieniu jeden z dwóch trybów. **Różnicownikiem są funkcje, nie liczba użytkowników** — dlatego oba współistnieją bez kanibalizacji.

| | **Offline‑standalone** | **Online** |
|---|---|---|
| Konto / serwer | brak | tak |
| Karty + PIN‑y | **2 + 2** (jak „Bez licencji", bez funkcji serwerowych) | wg pakietu (2/10/50/…) |
| Logi (serwer) | ❌ | ✅ (retencja wg pakietu) |
| Zdalny dostęp / multi‑admin / wiele centralek | ❌ | ✅ |
| Kody gościnne | ❌ | ✅ (od Silver) |
| Aktualizacje | **ręcznie/serwisowo** (brak kanału app) | OTA przez aplikację |
| Dla kogo | „max prywatność, zero chmury", pojedynczy zamek | firmy, rozliczalność, wzrost |

**Dlaczego to nie kanibalizuje:** offline‑standalone i online „Bez licencji" to **ten sam darmowy poziom (2+2)** — offline nie daje ani jednego użytkownika więcej. Różni się tylko **brakiem funkcji serwerowych** (logi, zdalny dostęp, kody gościnne, multi‑admin, upgrade). Kto potrzebuje czegokolwiek ponad „goły zamek na 2 osoby" — idzie online i ewentualnie płaci. Offline to po prostu darmowy poziom w wersji odłączonej, nie obejście.

**Uwaga o łatkach:** offline‑standalone nie jest podłączony do internetu → **mniejsza powierzchnia ataku** (brak zdalnej eksploatacji), a krytyczne łatki dostarcza się **ręcznie/serwisowo**. Główne ryzyko dla offline to atak **fizyczny** (nie objęty gwarancją — patrz §8).

**Uwaga o sieci centralki (audyt 11.09.2026):** „brak internetu” nie znaczy „brak powierzchni ataku”. Offline‑standalone zarządza się przez sieć Wi‑Fi centralki `CTRLABLE_SETUP`, która do 11.09.2026 była **otwarta**, a lokalne API chroniło hasło wyliczane z MAC‑a — każdy w zasięgu radiowym mógł otworzyć drzwi. Od poprawki sieć ma losowe hasło WPA2 (pokazywane tylko przy pierwszej konfiguracji), a lokalne API losowe hasło generowane przy każdej konfiguracji (README §7.1). Urządzenia offline sprzed poprawki trzeba zaktualizować **przez USB** i skonfigurować od nowa (README §7.8).

**Uwaga o anty‑Airbnb:** mechanizm (brak kodów gościnnych + limit zmian PIN/mies.) jest **egzekwowany przez serwer**, więc działa tylko online. Offline‑standalone nie ma serwera ani pewnego zegara — zdeterminowany host *mógłby* rotować PIN ręcznie, tracąc jednak kody gościnne, logi i aktualizacje. Akceptowalny, mały wyciek.

---

## 2. Limity SPRZĘTOWE (oś 1)

Wszystkie poświadczenia trzymane są **lokalnie** (LittleFS) i weryfikowane **lokalnie** (natychmiast, także przy braku łącza). Serwer w trybie online jedynie synchronizuje je w dół i robi backup.

| Parametr | Wartość | Uwagi |
|---|---|---|
| **Karty — sufit sprzętowy** | **500** *(prow.)* | maks. techniczny per centralka (bezpiecznik, niezależny od licencji) |
| **PIN‑y — sufit sprzętowy** | **500** *(prow.)* | jw. |
| **Działanie offline** | do limitu pakietu | zsynchronizowane poświadczenia działają przy zaniku łącza |
| **Wpisy logu lokalnego** | dziesiątki tysięcy | append w LittleFS, spływają na serwer po odzyskaniu łącza |
| **Weryfikacja** | lokalna, ~natychmiast | karty i PIN‑y (hash w urządzeniu) |

Rozmiary rekordów (orientacyjnie): karta ~40 B, PIN ~73 B (hash + nazwa + harmonogram + wygasanie/limit użyć).
Przy 500+500 to ~56 KB w LittleFS i RAM — komfortowo. Sufit można podnieść po bench‑teście.

Sufit sprzętowy jest **bezpiecznikiem**, nie produktem — chroni centralkę przed przeciążeniem RAM/flash/skanu, niezależnie od tego, co pozwala licencja.

---

## 3. Pakiety LICENCYJNE (oś 2)

Pakiety dotyczą **trybu online** (konto + serwer). Tryb **offline‑standalone** to osobny produkt bez konta — patrz §1a. „Bez licencji" to darmowy **online'owy** poziom startowy (nie mylić z offline‑standalone). Kolumny `karty`/`PIN‑y` = ile poświadczeń wolno na koncie (technicznie `max_cards` / `max_pins`).

| Pakiet | Karty | PIN‑y | Retencja logów | Kody gościnne | Zmiany PIN / mies. | Admini | Centralki |
|---|---|---|---|---|---|---|---|
| **Bez licencji** (darmowy) | 2 | 2 | 15 dni | ❌ | **limit** (np. 4) *(prow.)* | **2** (właściciel + 1) | 1 |
| **Silver** | 10 | 10 | 45 dni | ✅ | bez limitu | 3 *(prow.)* | 2 *(prow.)* |
| **Gold** | 50 | 50 | 90 dni | ✅ | bez limitu | bez limitu | bez limitu |
| **Indywidualna** | dowolnie (≤ sufit) | dowolnie (≤ sufit) | wg umowy | ✅ | bez limitu | wg umowy | wg umowy |

Pakiet to nie tylko liczba użytkowników — pakietuje też **retencję logów, kody gościnne, częstotliwość zmian PIN, adminów i liczbę centralek**. To mocniejszy upsell niż sam licznik.

### 3.1 Reguły segmentujące (celowane w konkretne przypadki)
- **Kody gościnne (wygasanie + limit użyć) = tylko licencja.** To domyka segment **najmu krótkoterminowego (Airbnb)**: na „Bez licencji" nie ma automatycznych kodów gościnnych, a ręczne zmiany PIN są limitowane (np. 4/mies.) — kto rotuje kody dla gości, musi wykupić licencję. Bez tej reguły host obchodziłby limit zmian PIN, ustawiając wygasające kody gościnne.
- **Limit zmian PIN/miesiąc** (tylko „Bez licencji"): liczony jako operacje add/usuń/edytuj PIN w miesiącu kalendarzowym. Cel: ten sam segment najmu.
- **Serwis nie zajmuje miejsca w limicie administratorów** (11 września 2026). Konto serwisowe (`SERVICE_ACCOUNTS` w `.env`, domyślnie `ctrlablenode@gmail.com`) klient zaprasza jak współadmina, ale zaproszenie omija `max_admins`, udział nie jest liczony do limitu i **wygasa sam po 48 h**. Klient z pełnym pakietem nigdy nie musi usuwać swojego administratora, żeby wpuścić serwis — inaczej limit karałby za zgłoszenie gwarancyjne. Rozszerzone czynności serwisowe wymagają dodatkowo kodu z ekranu centralki (README §7.15), więc to nie jest furtka do darmowego trzeciego admina.
- **Dwaj administratorzy na darmowym poziomie to świadoma decyzja** (9 września 2026), nie przeoczenie. Typowy nabywca zestawu to dom z dwiema osobami, które obie chcą mieć aplikację i otwierać zdalnie — przy `max_admins=1` darmowy poziom był dla nich rozczarowaniem od pierwszego dnia. Multi‑admin jako upsell zaczyna więc działać dopiero **od trzeciej osoby**: celem jest firma, nie para. Kosztu serwerowego to praktycznie nie rusza (jeden wiersz w `accounts` więcej).

### 3.2 Aktualizacje i wsparcie
- **Krytyczne łatki bezpieczeństwa — zawsze dostępne, dla każdego pakietu.** Uzasadnienie: to zamek — pozostawienie znanych luk to ryzyko dla klienta i odpowiedzialność producenta.
- **Dostarczanie:** online → OTA przez aplikację (automatycznie). **Offline‑standalone → ręcznie/serwisowo** (brak kanału app; ale i mniejsza powierzchnia ataku, bo bez internetu — §1a).
- **Nowe funkcje i wsparcie techniczne — tylko licencja** (Silver/Gold/Indywidualna). „Bez licencji" dostaje działający produkt + bezpieczeństwo, ale nie rozwój.

### 3.3 Cennik i model sprzedaży (ustalone 9 września 2026)

Licencje mają być **tanie względem sprzętu** — symboliczna opłata za utrzymanie miejsca i danych na serwerze, spójna z brandem „bez abonamentu za sprzęt". Opłata musi **pokrywać realny koszt serwerowy per konto** (storage rośnie z retencją i liczbą użytkowników), żeby skala nie generowała straty.

**Sprzęt sprzedawany jest bez klucza licencyjnego i bez zegara.** Rozważana była opcja „licencja na rok w zestawie" — **odrzucona**. Powodem nie jest cena, tylko odbiór przy zakupie: w momencie, w którym na pudełku pojawia się data ważności, klient czyta „abonament" i dolicza sobie koszt cykliczny. Tracimy główny argument sprzedażowy („płacisz raz za sprzęt"), nie zyskując w zamian przychodu — nabywca 2‑osobowy i tak nigdy nie kupiłby pakietu.

- **Darmowy poziom „Bez licencji" jest bezterminowy.** Zestaw kupiony dziś działa w tym samym zakresie za pięć lat, bez żadnej opłaty. To jest zdanie, które rozbraja obawę „czy będę musiał dopłacać" — musi być wprost na stronie i w materiałach.
- **Licencję klient kupuje wtedy, gdy sam po nią sięgnie** — w aplikacji, przy próbie dodania 3. karty albo kodu gościnnego. Komunikat brzmi „potrzebujesz więcej", a nie „skończyła się subskrypcja".
- **Okres domyślny: rok.** Miesięczny **tylko dla Silvera** — dla sezonowego najmu (kody gościnne od maja do września). Poza tym segmentem miesięczne rozliczenia to więcej pracy operacyjnej niż przychodu przy jednoosobowej firmie.
- **Widełki:** orientacyjnie **≤ 10% ceny zestawu rocznie** (przy zestawie ~1000 zł daje to rząd 60–120 zł/rok za Silvera). Powyżej tego progu opłata przestaje być odbierana jako „utrzymanie konta", a zaczyna jako renta. Dolna granica bez zmian: koszt serwerowy per konto. Konkretne kwoty — nadal decyzja biznesowa.
- **Przychód spoza licencji** — tam realnie leżą pieniądze przy zestawie za ~1000 zł i żadna z tych pozycji nie jest czynszem, więc nie psuje brandu: montaż i wdrożenie, przedłużona gwarancja (§8), kolejne centralki (sprzedaż sprzętu, nie licencji), jednorazowy podpisany klucz offline (§7).

### 3.4 Wygaśnięcie licencji — degradacja, nigdy blokada

**Zasada nadrzędna: to jest zamek. Nikt nigdy nie zostaje pod drzwiami z powodu płatności.** Reputacyjny koszt jednego takiego zdarzenia przewyższa cały przychód z licencji.

Po upływie `license_valid_until` konto schodzi do poziomu „Bez licencji", ale:

- **istniejące karty i PIN‑y działają dalej** — także te ponad limit 2+2 (grandfathering). Zejście z 10 kart na 2 nie może oznaczać, że ośmiu osobom przestaje otwierać drzwi;
- **istniejący współadministratorzy zachowują dostęp** (wiersze `device_shares` zostają) — blokowane jest zapraszanie kolejnych ponad limit;
- blokowane jest wyłącznie **dodawanie** nowych poświadczeń ponad darmowy limit oraz wystawianie nowych kodów gościnnych (już wydane dobiegają swojego wygaśnięcia), a retencja logów wraca do 15 dni;
- krytyczne łatki bezpieczeństwa lecą dalej, jak dla każdego pakietu (§3.2).

Technicznie: limit egzekwowany jest **wyłącznie na operacjach zapisu** (`POST /api/user/...`, `/api/keypad/add`, `/api/devices/invite`) — nigdy na synchronizacji poświadczeń do centralki ani na weryfikacji przy otwarciu. Firmware o licencji nie wie i wiedzieć nie powinien; pilnuje tylko sufitu sprzętowego (§2).

**Stan implementacji:** to już działa. `getEntitlements()` w `server.js` sprawdza `license_valid_until` przy każdym odczycie uprawnień i po wygaśnięciu zwraca preset `free` z flagą `expired`, a ponieważ limity sprawdzane są tylko przy dodawaniu, istniejące karty, PIN‑y i współadmini zostają nietknięte. Kody licencyjne (tier + liczba dni, jednorazowe) obsługuje tabela `license_codes` i `licensekey.js`, więc dołożenie kodu do zestawu jest technicznie trywialne — to, że tego nie robimy, jest decyzją produktową z §3.3, nie brakiem mechanizmu.

---

## 4. Jak to się składa (przykłady)

- **Bez licencji, mały sklep, 2 osoby:** 2 karty + 2 PIN‑y, dwoje właścicieli z aplikacją (2 adminy), logi 15 dni, brak kodów gościnnych, ręczne zmiany PIN limitowane. Dostaje łatki bezpieczeństwa, ale nie nowe funkcje — i nie płaci nigdy nic ponad zestaw.
- **Airbnb, „Bez licencji":** chce rotować kody dla gości → brak kodów gościnnych + limit zmian PIN/mies. wymusza wykup **Silver** (kody gościnne z wygasaniem). To celowana konwersja.
- **Silver, 1 drzwi, 8 osób:** wszyscy zsynchronizowani do LittleFS, weryfikacja lokalna, logi 45 dni. Dodanie 11. karty → serwer odmawia (limit 10) i proponuje Gold.
- **Gold, 3 drzwi, 40 osób:** licencja per konto = 50, mieści się. Każda centralka trzyma lokalnie użytkowników z dostępem do niej (≤ sufit sprzętowy 500).
- **Indywidualna, 120 osób:** `max_cards=120, max_pins=120` na koncie; poniżej sufitu 500.

---

## 5. Licencja per konto (nie per centralka)

Klient kupuje **plan na konto**, nie na sztukę sprzętu. Skutki:
- Limit „X użytkowników" liczy **odrębne osoby na koncie**.
- Ten sam użytkownik z dostępem do kilku drzwi jest synchronizowany na **każdą** z tych centralek (karta musi być lokalnie tam, gdzie ma otwierać).
- Każda centralka i tak nie przekroczy **sufitu sprzętowego** (oś 1) — to niezależny bezpiecznik.

---

## 6. Realizacja techniczna

**Na koncie (serwer, tabela `accounts`)** — pola liczbowe, nie sztywny enum:
- `max_cards`, `max_pins` — limit poświadczeń **na centralkę** (wg pakietu)
- `max_admins` — **łącznie z właścicielem**; darmowy `2` (właściciel + 1 współadmin), Silver `3`, Gold/Indywidualna `99`
- `max_devices` — **NIEUŻYWANE, limit centralek zniesiony (18.08.2026).** `getEntitlements()` zwraca tu zawsze `null`, żeby stare wartości w bazie nikogo nie blokowały. Kolumna została w schemacie, ale nic nie egzekwuje. Uzasadnienie: sprzedajemy **pojemność centralki**, nie liczbę pudełek.
- `log_retention_days`
- `guest_codes_enabled` (bool) — kody gościnne tylko od Silver w górę
- `pin_changes_per_month` — limit zmian PIN (`null` = bez limitu; darmowy: 4)
- `license_tier` — nazwa presetu (free/silver/gold/individual), tylko dla czytelności/UI
- `license_valid_until` — opcjonalnie, ważność umowy; po upływie **degradacja z grandfatheringiem**, nie blokada — patrz §3.4
- `email_verified`, `email_verify_code`, `email_verify_expires` — weryfikacja konta kodem 6-cyfrowym (niezwiązane z licencją, ta sama tabela)

**Tier = preset tych liczb** (`TIER_PRESETS` w `server.js`). „Indywidualna" = inne liczby, bez zmian w kodzie ani firmware.

**Egzekwowanie (stan faktyczny):**
- **Serwer**: `/api/toggle_learn` (blokuje wejście w Uczenie po wyczerpaniu `max_cards`), `/api/keypad/add` (`max_pins`, brama `guest_codes_enabled`, licznik `pin_changes_per_month`), `/api/devices/invite` (`max_admins` = współadmini + zaproszenia + właściciel). Odrzucenie to **403** z `{error, limit, used, tier, feature}`.
- **Centralka**: sufit sprzętowy `HW_MAX_CARDS = 200` kart w LittleFS (`/cards.db`), w trybie awaryjnym EEPROM 10 — twardy bezpiecznik niezależny od serwera.
- **Aplikacja**: limity przychodzą w **każdej** odpowiedzi `/api/data` (pole `entitlements`), więc moduły są **wyszarzane zawczasu** — przy komplecie kart/PIN-ów przycisk jest nieaktywny z wyjaśnieniem i skrótem do pakietów, a kody gościnne mają kłódkę i informację „dostępne od Silver". Klient nie dowiaduje się o limicie dopiero po kliknięciu.

### 6.0 Retencja danych — DWIE niezależne osie (ważne dla RODO i dla polityki prywatności)

Łatwo je pomylić, a w polityce prywatności muszą być opisane **osobno**, bo rządzą się inną logiką:

| | Historia zdarzeń (dane żywe) | Kopie zapasowe |
|---|---|---|
| Okres | **zależy od pakietu**: 15 / 45 / 90 dni | jeden, stały dla wszystkich |
| Po co | funkcja sprzedawana klientowi | odtworzenie po awarii |
| Kto ustala | `accounts.log_retention_days` | harmonogram Proxmoksa |
| Dostępne dla klienta | tak, w aplikacji | nie — „poza użyciem" |

**Retencja per-pakiet jest realnie egzekwowana**, nie jest deklaracją: `purgeExpiredData()` w `server.js` chodzi przy starcie i co 24 h, kasując `system_events` starsze niż `log_retention_days` **właściciela urządzenia**, z globalnym `LOG_RETENTION_DAYS` jako bezpiecznikiem dla zdarzeń osieroconych (MAC bez urządzenia). Sprząta też zużyte zaproszenia, bo trzymają e-maile.

**Skutek uboczny, który trzeba opisać klientowi:** po wygaśnięciu licencji konto schodzi do limitów darmowych (§3.4), więc `log_retention_days` spada np. z 90 na 15 — i **przy najbliższym przebiegu starsze zdarzenia zostaną usunięte**. To spójne z zasadą minimalizacji danych, ale dla klienta jest zaskoczeniem, jeśli nikt go nie uprzedził. Warto ująć to w regulaminie i rozważyć ostrzeżenie w aplikacji przed wygaśnięciem.

**Kopie zapasowe:** okres retencji musi być **skończony i udokumentowany** — to warunek postawienia ich „poza użyciem" przy żądaniu usunięcia danych. Nie rozpakowuje się backupów, żeby wyciąć jedną osobę; zamiast tego kasuje się z produkcji, kopia wygasa sama, a przy ewentualnym odtworzeniu stosuje się ponownie rejestr `erasure_requests` (hash e-maila, nigdy sam adres). **Liczba dni podawana klientowi w aplikacji i w polityce prywatności musi odpowiadać faktycznemu harmonogramowi Proxmoksa** — inaczej deklaracja jest nieprawdziwa.

### 6.1 Jak wystawić kod licencyjny (procedura operacyjna)

Kody generuje **skrypt na serwerze** — `licensekey.js`. Musi działać na backendzie, bo zapisuje kod do bazy (dostęp przez `.env`):

```bash
cd /opt/smartlock-server && node licensekey.js <silver|gold|individual> [okres]
```

Okres: `month` `quarter` `halfyear` `year` `2y` `3y` `5y` `lifetime` — albo liczba dni. Domyślnie `year`.

```bash
node licensekey.js gold year        # Gold na 12 miesięcy
node licensekey.js individual 5y    # Indywidualna na 5 lat
node licensekey.js silver month     # Silver na 30 dni
```

Skrypt wypisuje gotowy kod, np. `GOLD-A7K2-M9PX-3TRW`.

**Format:** 16 znaków — prefiks tieru (`SLVR`/`GOLD`/`INDV`) + 12 losowych z alfabetu bez mylących `0 O 1 I L`. W bazie (`license_codes`) leży bez myślników; przy aktywacji i tak jest normalizowany, więc klient może wpisać z myślnikami lub bez, wielkimi lub małymi literami.

**Aktywacja:** klient wpisuje kod w aplikacji → **💳 Pakiet i licencja → Aktywuj**. `POST /api/license/redeem` robi atomowe `UPDATE ... WHERE used_by IS NULL RETURNING`, więc jednego kodu **nie da się użyć dwa razy** nawet przy równoległych próbach. Po aktywacji konto dostaje liczby z `TIER_PRESETS[tier]`, a `license_valid_until` = `NOW() + dni` (albo `NULL` przy `lifetime`).

**Ważne dla modelu sprzedaży:** kod jest **rekordem w bazie**, nie podpisem kryptograficznym. Konsekwencje:
- kod musi zostać wygenerowany **na naszym serwerze, zanim** go wydasz klientowi — nie da się go wystawić „offline"
- nie zadziała w instalacji bez naszej chmury (patrz pomysł licencji offline w §7 — to osobna, jeszcze niezaprojektowana sprawa)
- kody można wygenerować z zapasem i trzymać (np. do wydruku/faktury) — do czasu aktywacji są po prostu nieużyte

Podgląd wystawionych i wykorzystanych kodów:
```sql
SELECT code, tier, days, used_by, used_at, created_at FROM license_codes ORDER BY created_at DESC LIMIT 20;
```

Ręczna zmiana pakietu bez kodu (np. do testów albo przy umowie indywidualnej) — te same wartości, co ustawiłby preset:
```sql
UPDATE accounts SET license_tier='free', max_cards=2, max_pins=2, max_admins=1,
       log_retention_days=15, guest_codes_enabled=false, pin_changes_per_month=4,
       license_valid_until=NULL
 WHERE email='klient@example.com';
```

**Aktualizacje:** krytyczne łatki bezpieczeństwa — kanał wspólny dla wszystkich (także „Bez licencji"). Nowe funkcje (flagi typu `guest_codes_enabled`) — tylko wg pakietu.

---

## 7. Do ustalenia
- **Ceny** pakietów — konkretne kwoty nadal do ustalenia. Widełki i model sprzedaży już **zamknięte** — §3.3 (bez zegara w zestawie, rok jako okres domyślny, ≤ 10% ceny zestawu rocznie).
- **Limit zmian PIN/mies.** dla „Bez licencji" — konkretna liczba (propozycja: 4).
- **Sufit sprzętowy** (tu 500/500) — do potwierdzenia bench‑testem (RAM + czas skanu przy pełnym magazynie).
- ~~**Ważność licencji** — co po wygaśnięciu~~ — **rozstrzygnięte 9 września 2026 (§3.4):** zejście do „Bez licencji" z grandfatheringiem istniejących poświadczeń i współadminów. Nigdy tryb, w którym ktoś nie wchodzi do budynku. Zaimplementowane w `getEntitlements()` (`server.js`) — patrz §3.4.
- **Regulamin gwarancyjny** — osobny dokument do stworzenia (patrz §8). Ustalone: **gwarancja 24 mies., możliwość przedłużenia za dopłatą (negocjowalne przy umowach indywidualnych)**. Brakuje jeszcze: kto montuje, proces reklamacji.
- **Licencja offline (przyszłość)** — dla segmentu „dużo użytkowników, zero chmury, płacę": jednorazowy **podpisany** klucz wpisywany przy inicjalizacji, który podnosi limit offline‑standalone **bez serwera** (firmware waliduje podpis). Obsługuje >2 użytkowników bez chmury, spójne z brandem. Do zaprojektowania.

---

## 8. Gwarancja (skrót — pełny „Regulamin gwarancyjny" jako osobny dokument)
- **Gwarancja pokrywa wady** produktu (materiał, wykonanie, komponenty), **nie szkody z przyczyn zewnętrznych.**
- **Wykluczenia** (typowe, do potwierdzenia): **włamanie/wandalizm/celowe uszkodzenie**, zalanie ponad normę, przepięcia/piorun, błędny montaż (jeśli nie przez producenta), nieautoryzowana ingerencja/naprawa, zużycie eksploatacyjne, siła wyższa.
- **Włamanie ≠ gwarancja** — od tego jest ubezpieczenie; oferować można **płatną naprawę/wymianę** lub opcjonalny pakiet ochronny.
- Czujnik **tamper** to detekcja/alarm, **nie pancerz**; kontroler montować po **bezpiecznej stronie drzwi**.
- Do ustalenia przed napisaniem regulaminu: **okres gwarancji**, **kto montuje**, **proces reklamacji**, powiązanie z **polityką aktualizacji** (§3.2).
