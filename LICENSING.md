# CTRLABLE Node — Model limitów i licencji

**Wersja robocza — 13 sierpnia 2026.** Liczby oznaczone *(prowizorycznie)* wymagają potwierdzenia:
ceny — decyzja biznesowa; sufit sprzętowy — walidacja na urządzeniu (bench‑test RAM/czasu skanu).

---

## 1. Zasada nadrzędna: dwie niezależne osie limitów

Limity biorą się z **dwóch różnych źródeł**, których nie wolno mieszać:

| Oś | Źródło | Kto pilnuje | Czy sprzedawane |
|---|---|---|---|
| **Sprzętowa** | fizyka urządzenia (flash, RAM, wydajność skanu) | firmware (centralka) | **nie** — to stała możliwość sprzętu |
| **Licencyjna** | pakiet wykupiony przez klienta | serwer (konto) | **tak** — to oferta handlowa |

**Efektywny limit = min(limit licencji, sufit sprzętowy).** Ponieważ sufit sprzętowy (~500) jest wyżej niż najwyższy pakiet, w praktyce **wiąże licencja** — sprzedaż, nie sprzęt.

**Offline = tryb odporności, nie osobny limit ani osobny produkt.** Wszystkie poświadczenia konta (do limitu pakietu) są synchronizowane lokalnie do centralki i działają natychmiast — także przy zaniku łącza. Darmowy poziom to pakiet **„Bez licencji" (2+2), również online** — nie ma „taniego offline", którym klient omija opłatę.

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
| **Bez licencji** (darmowy) | 2 | 2 | 15 dni | ❌ | **limit** (np. 4) *(prow.)* | 1 (właściciel) | 1 |
| **Silver** | 10 | 10 | 45 dni | ✅ | bez limitu | 3 *(prow.)* | 2 *(prow.)* |
| **Gold** | 50 | 50 | 90 dni | ✅ | bez limitu | bez limitu | bez limitu |
| **Indywidualna** | dowolnie (≤ sufit) | dowolnie (≤ sufit) | wg umowy | ✅ | bez limitu | wg umowy | wg umowy |

Pakiet to nie tylko liczba użytkowników — pakietuje też **retencję logów, kody gościnne, częstotliwość zmian PIN, adminów i liczbę centralek**. To mocniejszy upsell niż sam licznik.

### 3.1 Reguły segmentujące (celowane w konkretne przypadki)
- **Kody gościnne (wygasanie + limit użyć) = tylko licencja.** To domyka segment **najmu krótkoterminowego (Airbnb)**: na „Bez licencji" nie ma automatycznych kodów gościnnych, a ręczne zmiany PIN są limitowane (np. 4/mies.) — kto rotuje kody dla gości, musi wykupić licencję. Bez tej reguły host obchodziłby limit zmian PIN, ustawiając wygasające kody gościnne.
- **Limit zmian PIN/miesiąc** (tylko „Bez licencji"): liczony jako operacje add/usuń/edytuj PIN w miesiącu kalendarzowym. Cel: ten sam segment najmu.

### 3.2 Aktualizacje i wsparcie
- **Krytyczne łatki bezpieczeństwa — zawsze dostępne, dla każdego pakietu.** Uzasadnienie: to zamek — pozostawienie znanych luk to ryzyko dla klienta i odpowiedzialność producenta.
- **Dostarczanie:** online → OTA przez aplikację (automatycznie). **Offline‑standalone → ręcznie/serwisowo** (brak kanału app; ale i mniejsza powierzchnia ataku, bo bez internetu — §1a).
- **Nowe funkcje i wsparcie techniczne — tylko licencja** (Silver/Gold/Indywidualna). „Bez licencji" dostaje działający produkt + bezpieczeństwo, ale nie rozwój.

### 3.3 Cennik (zasada, nie liczby)
Licencje mają być **tanie względem sprzętu** — symboliczna opłata za utrzymanie miejsca i danych na serwerze, spójna z brandem „bez abonamentu za sprzęt". Zastrzeżenie: opłata powinna **pokrywać realny koszt serwerowy per konto** (storage rośnie z retencją i liczbą użytkowników), żeby skala nie generowała straty. Konkretne kwoty — decyzja biznesowa.

---

## 4. Jak to się składa (przykłady)

- **Bez licencji, mały sklep, 2 osoby:** 2 karty + 2 PIN‑y, logi 15 dni, brak kodów gościnnych, ręczne zmiany PIN limitowane. Dostaje łatki bezpieczeństwa, ale nie nowe funkcje.
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
- `max_cards`, `max_pins` — limit użytkowników (wg pakietu)
- `max_admins`, `max_devices`
- `log_retention_days`
- `guest_codes_enabled` (bool) — kody gościnne tylko od Silver w górę
- `pin_changes_per_month` — limit zmian PIN (tylko „Bez licencji"; np. 4)
- `license_tier` — nazwa presetu (Bez licencji/Silver/Gold/Individual), tylko dla czytelności/UI
- `license_valid_until` — opcjonalnie, ważność umowy

**Tier = preset tych liczb.** „Indywidualna" = ustawiasz liczby ręcznie. Dzięki temu każda prywatna umowa jest możliwa bez zmian w firmwarze ani w kodzie.

**Egzekwowanie:**
- **Serwer**: przy `POST /api/user/...` i `POST /api/keypad/add` sprawdza limit konta i licznik zmian PIN; blokuje ponad pakiet. Kody gościnne odrzuca, gdy `guest_codes_enabled=false`. Zwraca limity do aplikacji (pasek „8/10 kart").
- **Centralka**: pilnuje **sufitu sprzętowego (500)** — twardy bezpiecznik niezależny od serwera; weryfikuje lokalnie.
- **Aplikacja**: pokazuje wykorzystanie/limit, ukrywa/blokuje kody gościnne bez licencji, informuje o limicie zmian PIN.

**Aktualizacje:** krytyczne łatki bezpieczeństwa — kanał wspólny dla wszystkich (także „Bez licencji"). Nowe funkcje (flagi typu `guest_codes_enabled`) — tylko wg pakietu.

---

## 7. Do ustalenia
- **Ceny** pakietów — decyzja biznesowa (zasada: tanio względem sprzętu, ale ≥ koszt serwera per konto).
- **Limit zmian PIN/mies.** dla „Bez licencji" — konkretna liczba (propozycja: 4).
- **Sufit sprzętowy** (tu 500/500) — do potwierdzenia bench‑testem (RAM + czas skanu przy pełnym magazynie).
- **Ważność licencji** (`license_valid_until`) — czy egzekwować wygasanie, i co po wygaśnięciu: zejście do „Bez licencji" (2+2)? tryb tylko‑do‑odczytu? (Krytyczne łatki bezpieczeństwa zostają zawsze — §3.2.)
- **Regulamin gwarancyjny** — osobny dokument do stworzenia (patrz §8). Ustalone: **gwarancja 24 mies., możliwość przedłużenia za dopłatą (negocjowalne przy umowach indywidualnych)**. Brakuje jeszcze: kto montuje, proces reklamacji.
- **Licencja offline (przyszłość)** — dla segmentu „dużo użytkowników, zero chmury, płacę": jednorazowy **podpisany** klucz wpisywany przy inicjalizacji, który podnosi limit offline‑standalone **bez serwera** (firmware waliduje podpis). Obsługuje >2 użytkowników bez chmury, spójne z brandem. Do zaprojektowania.

---

## 8. Gwarancja (skrót — pełny „Regulamin gwarancyjny" jako osobny dokument)
- **Gwarancja pokrywa wady** produktu (materiał, wykonanie, komponenty), **nie szkody z przyczyn zewnętrznych.**
- **Wykluczenia** (typowe, do potwierdzenia): **włamanie/wandalizm/celowe uszkodzenie**, zalanie ponad normę, przepięcia/piorun, błędny montaż (jeśli nie przez producenta), nieautoryzowana ingerencja/naprawa, zużycie eksploatacyjne, siła wyższa.
- **Włamanie ≠ gwarancja** — od tego jest ubezpieczenie; oferować można **płatną naprawę/wymianę** lub opcjonalny pakiet ochronny.
- Czujnik **tamper** to detekcja/alarm, **nie pancerz**; kontroler montować po **bezpiecznej stronie drzwi**.
- Do ustalenia przed napisaniem regulaminu: **okres gwarancji**, **kto montuje**, **proces reklamacji**, powiązanie z **polityką aktualizacji** (§3.2).
