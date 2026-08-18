import React, { useState, useEffect, useRef, useCallback } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, TextInput, ScrollView, SafeAreaView, Alert, Animated, Dimensions, KeyboardAvoidingView, Platform, Switch, Linking, ActivityIndicator} from 'react-native';
import * as Haptics from 'expo-haptics';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import LoaderAnimation from './LoaderAnimation';
import BrandIcon from './BrandIcon';
import LoadingPulse from './LoadingPulse';

const { width } = Dimensions.get('window');

// Powiadomienia Push
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let AsyncStorage;
try {
  AsyncStorage = require('@react-native-async-storage/async-storage').default;
} catch (e) {
  AsyncStorage = {
    _cache: {},
    getItem: async (key) => AsyncStorage._cache[key] || null,
    setItem: async (key, val) => { AsyncStorage._cache[key] = String(val); },
    removeItem: async (key) => { delete AsyncStorage._cache[key]; }
  };
}

// 🌟 TRYB LOKALNY: gdy centralka jest skonfigurowana jako w pełni offline,
// ZAWSZE nadaje swój własny punkt dostępu pod tym stałym adresem - więc nie
// trzeba żadnego wykrywania urządzenia w sieci domowej.
const LOCAL_BASE_URL = 'http://192.168.4.1';

// Niektóre akcje mają inną nazwę ścieżki w lokalnym API wbudowanym w firmware
// niż w API serwera chmurowego (np. "/api/user/delete" -> "/api/delete_user").
const LOCAL_ENDPOINT_MAP = {
  '/api/unlock': '/api/unlock',
  '/api/toggle_learn': '/api/toggle_learn',
  '/api/user/rename': '/api/rename_user',
  '/api/user/toggle_active': '/api/toggle_user_active',
  '/api/user/delete': '/api/delete_user',
};

// Buduje pełny URL do lokalnego API centralki, dopisując parametry z payloadu
// (firmware lokalnie przyjmuje wszystko jako parametry GET, nie jako JSON body)
// oraz hasło administratora wymagane przez zapisujące endpointy.
function buildLocalRequestUrl(endpoint, payload, adminPass) {
  const qIdx = endpoint.indexOf('?');
  const basePath = qIdx === -1 ? endpoint : endpoint.substring(0, qIdx);
  const existingQuery = qIdx === -1 ? '' : endpoint.substring(qIdx + 1);
  const localPath = LOCAL_ENDPOINT_MAP[basePath] || basePath;

  const parts = existingQuery ? [existingQuery] : [];
  if (payload) {
    Object.keys(payload).forEach((key) => {
      parts.push(`${key}=${encodeURIComponent(payload[key])}`);
    });
  }
  parts.push(`pass=${encodeURIComponent(adminPass || '')}`);
  return `${LOCAL_BASE_URL}${localPath}?${parts.join('&')}`;
}

export default function App() {
  let [backendUrl, setBackendUrl] = useState('https://node.ctrlable.pl');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accountId, setAccountId] = useState(null);    // kept for local-mode compat
  const [devices, setDevices] = useState([]);           // multi-device: lista wszystkich centralek na koncie
  const [selectedMac, setSelectedMac] = useState('');    // multi-device: aktualnie wybrana centralka
  const [showDeviceSwitcher, setShowDeviceSwitcher] = useState(false);
  const [renameDeviceMac, setRenameDeviceMac] = useState(null); // MAC aktualnie zmienianej centralki | null
  const [renameDeviceInput, setRenameDeviceInput] = useState('');
  const [acceptCodeVisible, setAcceptCodeVisible] = useState(false); // modal "Mam kod zaproszenia"
  const [acceptCodeInput, setAcceptCodeInput] = useState('');
  const [deregVisible, setDeregVisible] = useState(false);   // modal deregistracji centralki
  const [deregStep, setDeregStep] = useState('request');     // 'request' → 'code'
  const [deregCodeInput, setDeregCodeInput] = useState('');
  const [deregBusy, setDeregBusy] = useState(false);
  const [authToken, setAuthToken]  = useState(null);    // signed JWT from server
  const [isConfigured, setIsConfigured] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isRegisterMode, setIsRegisterMode] = useState(false);
  const [isForgotPasswordMode, setIsForgotPasswordMode] = useState(false);

  // 🌟 TRYB LOKALNY / OFFLINE: brak konta w chmurze, aplikacja rozmawia
  // bezpośrednio z centralką po jej własnym AP (http://192.168.4.1),
  // autoryzując zapisy algorytmicznym "fabrycznym" hasłem urządzenia.
  const [isLocalMode, setIsLocalMode] = useState(false);
  const [localAdminPass, setLocalAdminPass] = useState('');

  // STANY I FUNKCJA PUSH
  const [pushEntries, setPushEntries] = useState(true);
  const [keypadPins, setKeypadPins]   = useState([]);   // [{id, name, active}]
  const [kpNewName, setKpNewName]     = useState('');
  const [kpNewCode, setKpNewCode]     = useState('');
  const [kpNewConfirm, setKpNewConfirm] = useState('');
  const [kpStatus, setKpStatus]       = useState('');
  const [kpMode, setKpMode]           = useState('normal'); // 'normal' | 'guest'
  const [kpGuestExpiryDays, setKpGuestExpiryDays] = useState('1'); // ile dni ważności kodu gościnnego
  const [kpGuestMaxUses, setKpGuestMaxUses] = useState('');  // puste = bez limitu użyć
  const [kpScheduleEditId, setKpScheduleEditId] = useState(null); // id PINu LUB id/idx karty, której harmonogram edytujemy
  const [kpScheduleEditIsDbId, setKpScheduleEditIsDbId] = useState(true); // czy powyższe to stabilne id z bazy (nie slot sprzętowy)
  const [kpScheduleTargetType, setKpScheduleTargetType] = useState('pin'); // 'pin' | 'card' — rozróżnia który endpoint wywołać
  const [kpScheduleEnabled, setKpScheduleEnabled] = useState(false);
  const [kpScheduleDays, setKpScheduleDays] = useState(127);      // bitmask: bit0=Nd..bit6=So, 127=wszystkie
  const [kpScheduleStartText, setKpScheduleStartText] = useState('08:00');
  const [kpScheduleEndText, setKpScheduleEndText] = useState('20:00');
  const [kpRenameId, setKpRenameId]   = useState(null);
  const [kpRenameName, setKpRenameName] = useState('');
  const [autoLockSeconds, setAutoLockSeconds] = useState({}); // { [mac]: sekundy } — optymistyczny wybór czasu otwarcia
  const [cardRenameIdx, setCardRenameIdx] = useState(null); // KTÓRY wiersz jest w edycji (stabilny klucz karty)
  const [cardRenameRef, setCardRenameRef] = useState(null); // CZYM zaadresować mutację: {id} lub {idx} (stare buildy)
  const [cardRenameName, setCardRenameName] = useState('');
  const [pushAlarms, setPushAlarms] = useState(true);

  // ── Keypad PIN management ────────────────────────────────────────────────────
  const kpAuthHeader = authToken ? { 'Authorization': `Bearer ${authToken}` } : {};

  const kpAdd = async () => {
    if (!kpNewName.trim())  { setKpStatus('Podaj nazwę'); return; }
    if (kpNewCode.length < 4) { setKpStatus('PIN musi mieć min. 4 cyfry'); return; }
    if (kpNewCode !== kpNewConfirm) { setKpStatus('PINy nie są identyczne'); return; }

    const payload = { name: kpNewName.trim(), pin: kpNewCode };
    // PIN-y są per centralka — dołączamy MAC aktualnie wybranego urządzenia, żeby
    // serwer zapisał kod dla właściwej centralki (bez tego trafiłby na pierwszą).
    if (!isLocalMode && selectedMac) payload.mac = selectedMac;

    // Tryb gościnny tylko gdy pakiet go obejmuje — inaczej wysyłamy zwykły PIN
    // (UI i tak jest wyszarzone; to zabezpieczenie na wypadek zmiany pakietu w tle).
    if (kpMode === 'guest' && (isLocalMode || lockState.entitlements?.guestCodes !== false)) {
      const days = parseInt(kpGuestExpiryDays, 10);
      if (!days || days < 1) { setKpStatus('Podaj liczbę dni ważności (min. 1)'); return; }
      const expiryDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      payload.isGuestCode = true;
      payload.expiresAt = expiryDate.toISOString();
      if (kpGuestMaxUses.trim()) {
        const uses = parseInt(kpGuestMaxUses, 10);
        if (uses > 0) payload.maxUses = uses;
      }
    }

    try {
      const r = await fetch(`${backendUrl}/api/keypad/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...kpAuthHeader },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (d.success) {
        setKpNewName(''); setKpNewCode(''); setKpNewConfirm(''); setKpGuestMaxUses('');
        setKpStatus('✓ Dodano: ' + kpNewName.trim());
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else { setKpStatus('✗ ' + (d.error || 'Błąd serwera')); }
    } catch { setKpStatus('✗ Brak połączenia'); }
  };

  const kpDelete = async (id, name) => {
    await fetch(`${backendUrl}/api/keypad/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...kpAuthHeader },
      body: JSON.stringify({ id }),
    });
    setKpStatus('✓ Usunięto: ' + name);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const kpToggle = async (id) => {
    await fetch(`${backendUrl}/api/keypad/toggle_active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...kpAuthHeader },
      body: JSON.stringify({ id }),
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const kpRename = async () => {
    if (!kpRenameName.trim()) return;
    await fetch(`${backendUrl}/api/keypad/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...kpAuthHeader },
      body: JSON.stringify({ id: kpRenameId, name: kpRenameName.trim() }),
    });
    setKpRenameId(null); setKpRenameName('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  // ── Harmonogram dostępu (dni tygodnia + okno godzinowe) ────────────────────
  // Wyświetlamy dni od poniedziałku, ale bitmaska w bazie MUSI pozostać
  // zgodna z JS getDay() (0=Niedziela..6=Sobota) — DAY_DISPLAY_ORDER mapuje
  // pozycję na ekranie na właściwy bit, więc "Pn" zawsze przełącza bit 1 itd.
  const DAY_LABELS = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'];
  const DAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // getDay() index dla każdej pozycji na ekranie

  const parseTimeToMinutes = (text) => {
    const m = text.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
  };

  const minutesToTimeText = (mins) => {
    const h = Math.floor(mins / 60).toString().padStart(2, '0');
    const m = (mins % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
  };

  const openScheduleEditor = (entity, type = 'pin') => {
    setKpScheduleTargetType(type);
    // Karty: preferuj stabilne id z bazy; entity.idx (slot sprzętowy) tylko gdy serwer
    // jeszcze nie zwraca `id` — inaczej harmonogram trafiłby w niewłaściwą kartę.
    setKpScheduleEditId(type === 'pin' ? entity.id : (entity.id != null ? entity.id : entity.idx));
    setKpScheduleEditIsDbId(type === 'pin' || entity.id != null);
    setKpScheduleEnabled(!!entity.schedule_enabled);
    setKpScheduleDays(entity.schedule_days ?? 127);
    setKpScheduleStartText(minutesToTimeText(entity.schedule_start_minutes ?? 0));
    const endMinRaw = entity.schedule_end_minutes ?? 1440;
    setKpScheduleEndText(minutesToTimeText(endMinRaw >= 1440 ? 1439 : endMinRaw));
  };

  const toggleScheduleDay = (displayIndex) => {
    const jsDay = DAY_DISPLAY_ORDER[displayIndex];
    setKpScheduleDays(prev => prev ^ (1 << jsDay));
  };

  const saveSchedule = async () => {
    const startMin = parseTimeToMinutes(kpScheduleStartText);
    const endMin = parseTimeToMinutes(kpScheduleEndText);
    if (kpScheduleEnabled && (startMin === null || endMin === null)) {
      Alert.alert('Błąd', 'Podaj godziny w formacie GG:MM (np. 08:00).');
      return;
    }
    if (kpScheduleEnabled && startMin >= endMin) {
      Alert.alert('Błąd', 'Godzina początkowa musi być wcześniejsza niż końcowa.');
      return;
    }
    try {
      const endpoint = kpScheduleTargetType === 'card'
        ? '/api/user/update_schedule'
        : '/api/keypad/update_schedule';
      const idField = (kpScheduleTargetType === 'card' && !kpScheduleEditIsDbId)
        ? { idx: kpScheduleEditId }        // stary serwer bez `id` — adresowanie slotem
        : { id: kpScheduleEditId };
      await fetch(`${backendUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...kpAuthHeader },
        body: JSON.stringify({
          ...idField,
          scheduleEnabled: kpScheduleEnabled,
          scheduleDays: kpScheduleDays,
          scheduleStartMinutes: startMin ?? 0,
          scheduleEndMinutes: endMin ?? 1440,
        }),
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setKpScheduleEditId(null);
      fetchStatus();
    } catch {
      Alert.alert('Błąd', 'Nie udało się zapisać harmonogramu.');
    }
  };
  // ─────────────────────────────────────────────────────────────────────────────

  const savePushPreferences = (entries, alarms) => {
    fetch(`${backendUrl}/api/settings/push_preferences`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
      },
      body: JSON.stringify({ pushEntries: entries, pushAlarms: alarms })
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      })
      .catch((err) => console.log("Błąd zapisu preferencji push:", err));
  };

  // STANY OBSŁUGI BEZPIECZNEGO RESETU HASŁA (OPCJA B)
  const [resetStep, setResetStep] = useState(1);
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');

  // STAN OBSŁUGI AKTUALIZACJI OTA
  const [otaState, setOtaState] = useState('idle');
  const [latestVersion, setLatestVersion] = useState('');

  // STAN WIDOCZNOŚCI HASEŁ
  const [secureLogin, setSecureLogin] = useState(true);
  const [secureReset, setSecureReset] = useState(true);
  const [secureSettingsApp, setSecureSettingsApp] = useState(true);
  const [secureSettingsWifi, setSecureSettingsWifi] = useState(true);

  // INICJALIZACJA
  // Nowy przepływ: 'mode' (online/offline) → (online) 'account_choice' → 'login'|'register'
  // → 'verify' → 'connect' → 'onboarding'. Offline: 'mode' → 'connect' → 'onboarding'.
  const [authStep, setAuthStep] = useState('mode');
  const [initMode, setInitMode] = useState('online'); // 'online' | 'offline' — wybrany na ekranie 'mode'
  const [verifyCode, setVerifyCode] = useState('');    // 6-cyfrowy kod weryfikacji e-mail
  const [isScanning, setIsScanning] = useState(false);
  const [detectedDevice, setDetectedDevice] = useState(false);

  // ZGODY REGULAMINU I POLITYKI PRYWATNOŚCI
  const [isPrivacyAccepted, setIsPrivacyAccepted] = useState(false);

  // PODTRZYMANIE SESJI PO WYŁĄCZENIU APLIKACJI
  const [isLoading, setIsLoading] = useState(true);
  // Czy animacja powitalna (logo) zdążyła się odtworzyć do końca - trzymamy
  // splash na ekranie aż oba warunki (dane wczytane ORAZ animacja skończona)
  // będą spełnione, żeby intro nigdy nie urywało się w pół animacji.
  const [splashAnimationDone, setSplashAnimationDone] = useState(false);

  const [lockState, setLockState] = useState({
    auth: false,
    account: { email: '-' },
    mode: '-',
    lock: false,
    total: 0,
    users: [],
    logs: [],
    ssid: 'Ecosystem LAN',
    version: '2.9.4',
    otaProgress: 0,
    tamper: false   // true when second-board enclosure tamper switch is open
  });

  const [newName, setNewName] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [currentScreen, setCurrentScreen] = useState('dashboard');
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuAnimation = useRef(new Animated.Value(-width * 0.75)).current;
  // Logo w nagłówku przygasa, gdy szuflada menu się otwiera - tym samym
  // Animated.Value co sama szuflada, więc jest to zawsze idealnie zsynchronizowane,
  // bez osobnego wyzwalacza czy ryzyka rozjazdu w czasie.
  const headerLogoOpacity = menuAnimation.interpolate({
    inputRange: [-width * 0.75, 0],
    outputRange: [1, 0.35],
  });
  const drawerLogoScale = useRef(new Animated.Value(0.6)).current;
  // Znacznik czasu ostatniego /api/unlock - chroni stan 'pending' przed
  // nadpisaniem przez chwilowo nieaktualny odczyt z serwera (patrz fetchStatus).
  const pendingUnlockSinceRef = useRef(0);
  // 🌟 Zawsze aktualne "zwierciadło" lockState. setInterval() w handleExecuteUpdate
  // przechwytuje zmienne z chwili swojego utworzenia (stale closure) - bez tego refa
  // sprawdzałby tam już nieaktualną wersję na zawsze, nawet gdy fetchStatus()
  // faktycznie odświeża prawdziwy stan w tle. Stąd zgłaszany "timeout", mimo że
  // aktualizacja w rzeczywistości się powiodła.
  const lockStateRef = useRef(lockState);
  useEffect(() => {
    lockStateRef.current = lockState;
  }, [lockState]);

  const [logoTapCount, setLogoTapCount] = useState(0);
  const [showInstallerMenu, setShowInstallerMenu] = useState(false);
  const [installerUrlInput, setInstallerUrlInput] = useState('');

  const [settingsSsid, setSettingsSsid] = useState('');
  const [settingsWifiPass, setSettingsWifiPass] = useState('');
  const [settingsAppPass, setSettingsAppPass] = useState('');

  const resetUiToDefault = useCallback(() => {
    setCurrentScreen('dashboard');
    setIsMenuOpen(false);
    menuAnimation.setValue(-width * 0.75);
  }, [menuAnimation]);

  // Przy starcie aplikacji: przywracamy zapisaną sesję (tryb lokalny lub chmurowy)
  // z pamięci urządzenia, a na końcu ZAWSZE zwalniamy ekran ładowania.
  useEffect(() => {
    (async () => {
      try {
        const storedLocalMode = await AsyncStorage.getItem('@lock_local_mode');
        const storedLocalPass = await AsyncStorage.getItem('@lock_local_admin_pass');
        if (storedLocalMode === '1' && storedLocalPass) {
          setIsLocalMode(true);
          setLocalAdminPass(storedLocalPass);
          resetUiToDefault();
          setIsConfigured(true);
        } else {
          const storedAccountId = await AsyncStorage.getItem('@lock_account_id');
          const storedToken     = await AsyncStorage.getItem('@lock_auth_token');
          const storedEmail     = await AsyncStorage.getItem('@lock_account_email');
          if (storedToken || storedAccountId) {
            if (storedToken)     setAuthToken(storedToken);
            if (storedAccountId) setAccountId(parseInt(storedAccountId, 10));
            // E-mail konta MUSI przetrwać przeładowanie bundla — przy przełączeniu telefonu
            // na CTRLABLE_SETUP Metro się rozłącza i Expo Go przeładowuje apkę, przez co stan
            // `email` znikał i centralka dostawała PUSTY e-mail (poll: email='' → brak rejestracji).
            if (storedEmail)     setEmail(storedEmail);
            resetUiToDefault();
            setIsConfigured(true);
          }
        }
      } catch (e) {
        console.error("Blad odczytu pamieci podrecznej:", e);
      } finally {
        setIsLoading(false);
      }
    })();
  }, [resetUiToDefault]);

  const toggleBurgerMenu = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const opening = !isMenuOpen;
    const toValue = isMenuOpen ? -width * 0.75 : 0;
    Animated.timing(menuAnimation, {
      toValue: toValue,
      duration: 250,
      useNativeDriver: false,
    }).start();
    if (opening) {
      // Logo w szufladzie "ląduje" z małym odbiciem - jakby to ta sama
      // ikona z nagłówka właśnie dotarła na miejsce.
      drawerLogoScale.setValue(0.6);
      Animated.spring(drawerLogoScale, { toValue: 1, friction: 5, tension: 80, useNativeDriver: true }).start();
    }
    setIsMenuOpen(!isMenuOpen);
  };

  const navigateTo = (screen) => {
    setCurrentScreen(screen);
    toggleBurgerMenu();
  };

  const handleLogoTap = () => {
    const newCount = logoTapCount + 1;
    if (newCount >= 5) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setShowInstallerMenu(true);
      setLogoTapCount(0);
    } else {
      setLogoTapCount(newCount);
      setTimeout(() => setLogoTapCount(0), 2000);
    }
  };

  const saveInstallerConfig = async () => {
    if (!installerUrlInput) return;
    let cleanUrl = installerUrlInput.trim().replace('https://', '').replace('http://', '');
    cleanUrl = `http://${cleanUrl}`;
    try {
      await AsyncStorage.setItem('@lock_backend_endpoint', cleanUrl);
      setBackendUrl(cleanUrl);
      setShowInstallerMenu(false);
      setErrorMessage('');
      Alert.alert('Configuration Rerouted', `System cloud core remapped to:\n${cleanUrl}`);
    } catch (e) {
      Alert.alert('Storage Error', 'Failed to save configuration profile.');
    }
  };

  // 🌟 INICJALIZACJA W TRYBIE LOKALNYM (BEZ INTERNETU): centralka nigdy nie
  // próbuje połączyć się z żadną siecią domową i nigdy nie wymaga konta w
  // chmurze - aplikacja rozmawia z nią wyłącznie po jej własnym punkcie
  // dostępu (CTRLABLE_SETUP / 192.168.4.1), autoryzując zapisy algorytmicznym
  // hasłem fabrycznym, które centralka oddaje od razu po konfiguracji.
  const handleOfflineSetup = () => {
    setIsAuthenticating(true);
    fetch(`http://192.168.4.1/save_setup?s=OFFLINE&p=NONE&m=${encodeURIComponent(email)}&reg_pass=&offline=1`)
      .then((res) => res.json())
      .then(async (data) => {
        setIsAuthenticating(false);
        if (!data || !data.admin_pass) throw new Error('missing admin_pass');

        await AsyncStorage.setItem('@lock_local_mode', '1');
        await AsyncStorage.setItem('@lock_local_admin_pass', data.admin_pass);
        setLocalAdminPass(data.admin_pass);
        setIsLocalMode(true);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert(
          "Tryb Lokalny Aktywny",
          "Centralka działa teraz całkowicie bez internetu - karty RFID i przycisk fizyczny pracują od razu. Zarządzanie z aplikacji odbywa się przez sieć Wi-Fi centralki (CTRLABLE_SETUP), więc telefon musi pozostać w tej sieci."
        );
        resetUiToDefault();
        setIsConfigured(true);
      })
      .catch(() => {
        setIsAuthenticating(false);
        Alert.alert('Błąd połączenia', 'Nie można dostarczyć pakietów do 192.168.4.1. Sprawdź czy telefon jest w sieci CTRLABLE_SETUP.');
      });
  };

  const handleAccountRegistration = () => {
    // ZGODA RODO
    console.log("=== FRONTEND SENDING ===", { email, password });
    if (!isPrivacyAccepted) {
      Haptics.notificationAsync(Haptics.ImpactFeedbackStyle.Error);
      Alert.alert(
        "Wymagana akceptacja",
        "Musisz zaakceptować Regulamin oraz Politykę Prywatności, aby utworzyć konto Master."
      );
      return;
    }

    setIsAuthenticating(true);

    // Strzał do Twojego oficjalnego endpointu
    fetch(`${backendUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: email,
        password: password,
        privacy_policy_accepted: true // Przekazanie zgody do backendu
      }),
    })
    .then(response => response.json())
    .then(data => {
      setIsAuthenticating(false);

      // Nowy przepływ: serwer zwraca "code_sent" (konto nieaktywne, kod wysłany na e-mail).
      // Przechodzimy na ekran wpisania kodu 6-cyfrowego.
      if (data.status === "code_sent") {
        setErrorMessage('');
        Alert.alert("Sprawdź e-mail", "Wysłaliśmy 6-cyfrowy kod weryfikacyjny na Twój adres. Wpisz go, aby aktywować konto.");
        setAuthStep('verify');
      } else if (data.status === "registered") {
        // Zgodność wsteczna ze starym serwerem (bez weryfikacji).
        Alert.alert("Sukces", "Konto zostało utworzone. Możesz się zalogować.");
        setAuthStep('login');
      } else {
        setErrorMessage(data.error || "Błąd podczas tworzenia konta.");
      }
    })
    .catch(error => {
      setIsAuthenticating(false);
      setErrorMessage("Błąd połączenia z węzłem backendu.");
      console.error(error);
    });
  };

  // Weryfikacja e-mail kodem 6-cyfrowym. Serwer aktywuje konto, zwraca JWT i wysyła
  // e-mail powitalny. Po sukcesie przechodzimy do dodania centralki (konto świeże).
  const verifyEmailCode = async () => {
    if (!email || !verifyCode) { setErrorMessage('Podaj kod z e-maila.'); return; }
    setIsAuthenticating(true);
    setErrorMessage('');
    try {
      const res = await fetch(`${backendUrl}/api/auth/verify_email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), code: verifyCode.trim() })
      });
      const data = await res.json();
      setIsAuthenticating(false);
      if (data.status === 'verified' || data.status === 'already_verified') {
        if (data.token) { await AsyncStorage.setItem('@lock_auth_token', data.token); setAuthToken(data.token); }
        if (data.accountId) { await AsyncStorage.setItem('@lock_account_id', String(data.accountId)); setAccountId(data.accountId); }
        await AsyncStorage.setItem('@lock_account_email', email.trim().toLowerCase());
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setVerifyCode('');
        setInitMode('online');
        setDetectedDevice(false);
        setAuthStep('connect'); // konto aktywne → przejdź do dodania centralki
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setErrorMessage(data.error || 'Kod nieprawidłowy lub wygasł.');
      }
    } catch (e) {
      setIsAuthenticating(false);
      setErrorMessage('Błąd połączenia z serwerem.');
    }
  };

  const handleSecurityLogin = async () => {
    if (!email || !password) return;
    setIsAuthenticating(true);
    setErrorMessage('Processing identity authentication flags...');

    fetch(`${backendUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password: password.trim() })
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok, httpStatus: res.status, data };
      })
      .then(async ({ ok, httpStatus, data }) => {
        setIsAuthenticating(false);
        // Konto niezweryfikowane → serwer wysłał świeży kod; przejdź do ekranu weryfikacji.
        if (httpStatus === 403 && data.status === 'unverified') {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          setErrorMessage('');
          Alert.alert('Zweryfikuj konto', 'To konto nie jest jeszcze potwierdzone. Wysłaliśmy nowy kod na Twój e-mail.');
          setAuthStep('verify');
          return;
        }
        if (ok && data.auth && (data.token || data.accountId)) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          // Store the signed JWT; fall back to accountId for older server builds
          const tok = data.token || null;
          const aid = data.accountId || null;
          if (tok) {
            await AsyncStorage.setItem('@lock_auth_token', tok);
            setAuthToken(tok);
          }
          if (aid) {
            await AsyncStorage.setItem('@lock_account_id', String(aid));
            setAccountId(aid);
          }
          // Trwały e-mail konta — używany przy inicjalizacji centralki (owner w pollu).
          await AsyncStorage.setItem('@lock_account_email', email.trim().toLowerCase());
          resetUiToDefault();
          setIsConfigured(true);
          setErrorMessage('');
          registerForPushNotificationsAsync(aid);
        } else {
          throw new Error();
        }
      })
      .catch(() => {
        setIsAuthenticating(false);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setErrorMessage('Access Denied: Invalid email configuration or bad key.');
      });
  };

  // WYLOGOWANY UŻYTKOWNIK

  const handleLogout = async () => {
    // 1. Best-effort: powiadamiamy backend, żeby wyłączył pushe dla tego konta.
    //    NIE może to blokować wylogowania — gdy backend/sieć są niedostępne, fetch
    //    rzuca "Network request failed", a użytkownik i tak MUSI móc się wylogować.
    if (authToken) {
      try {
        await fetch(`${backendUrl}/api/auth/save_push_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
          body: JSON.stringify({ token: 'LOGGED_OUT' })
        });
      } catch (e) {
        console.warn('Wylogowanie: nie udało się powiadomić backendu, kontynuuję lokalnie:', e?.message);
      }
    }

    try {
      // 2. Czyścimy pamięć lokalną sesji w telefonie (konto w chmurze i/lub Tryb Lokalny)
      await AsyncStorage.removeItem('@lock_account_id');
      await AsyncStorage.removeItem('@lock_auth_token');
      await AsyncStorage.removeItem('@lock_account_email');
      await AsyncStorage.removeItem('@lock_local_mode');
      await AsyncStorage.removeItem('@lock_local_admin_pass');

      // 3. 🛠️ TWOJE RESETOWANIE INTERFEJSU (UI):
      menuAnimation.setValue(-width * 0.75);
      setIsMenuOpen(false);
      setCurrentScreen('dashboard');
      setAccountId(null);
      setIsLocalMode(false);
      setLocalAdminPass('');
      setIsConfigured(false);

      console.log('🔒 Pełne bezpieczne wylogowanie wykonane pomyślnie.');
    } catch (error) {
      console.error("Błąd podczas potoku wylogowywania:", error);
    }
  };

  // PIPELINE ODZYSKIWANIA HASŁA (3 KROKI)
  const handleForgotPasswordSubmit = () => {
    if (!email) return Alert.alert('Błąd', 'Wprowadź swój adres email!');
    setIsAuthenticating(true);
    setErrorMessage('Wysyłanie cyfrowego kodu weryfikacyjnego...');

    fetch(`${backendUrl}/api/auth/forgot_password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim() })
    })
      .then((res) => {
        setIsAuthenticating(false);
        if (res.status === 200) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Alert.alert('Kod został wysłany', 'Jeśli adres istnieje w systemie, wysłano 6-cyfrowy kod autoryzacyjny.');
          setResetStep(2); // Przejdź do pola wpisywania kodu
          setErrorMessage('');
        } else {
          alert('Wystąpił błąd po stronie serwera.');
        }
      })
      .catch(() => {
        setIsAuthenticating(false);
        alert('Błąd sieci. Spróbuj ponownie.');
      });
  };

  // Scala dane przychodzące z serwera/lokalnej centralki ze stanem UI.
  const mergeLockState = useCallback((prev, data) => {
    return { ...prev, ...data };
  }, []);

  // Główna funkcja odpytująca o aktualny stan zamka — działa zarówno
  // w trybie chmurowym (backendUrl), jak i lokalnym (LOCAL_BASE_URL).
  const fetchStatus = useCallback(() => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const macParam = (!isLocalMode && selectedMac) ? `?mac=${encodeURIComponent(selectedMac)}` : '';
    const url = isLocalMode
      ? `${LOCAL_BASE_URL}/api/data?pass=${encodeURIComponent(localAdminPass)}`
      : `${backendUrl}/api/data${macParam}`;
    const headers = (!isLocalMode && authToken) ? { 'Authorization': `Bearer ${authToken}` } : {};

    fetch(url, { signal: controller.signal, headers })
      .then((res) => {
        clearTimeout(timeoutId);
        return res.json();
      })
      .then((data) => {
        if (data.auth === false) {
          setIsConfigured(false);
          return;
        }
        setErrorMessage('');
        setLockState(prev => ({ ...prev, _failCount: 0 }));
        if (data.pushEntries !== undefined) setPushEntries(data.pushEntries);
        if (data.pushAlarms  !== undefined) setPushAlarms(data.pushAlarms);
        if (data.keypad_pins !== undefined) setKeypadPins(data.keypad_pins);
        if (data.devices !== undefined) setDevices(data.devices);
        if (data.activeMac && !selectedMac) setSelectedMac(data.activeMac);
        setLockState(prevState => mergeLockState(prevState, data));
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        const isPending = pendingUnlockSinceRef.current && (Date.now() - pendingUnlockSinceRef.current) < 20000;
        setLockState(prevState => {
          if (isPending || prevState.lock === 'pending' || prevState.lock === true) {
            return prevState;
          }
          const fails = (prevState._failCount || 0) + 1;
          if (fails < 3) {
            return { ...prevState, _failCount: fails };
          }
          setErrorMessage('Brak połączenia z centralką (Offline)');
          return { ...prevState, lock: 'offline', _failCount: 0 };
        });
        console.error("Fetch status error:", err.message);
      });
  }, [backendUrl, authToken, isLocalMode, localAdminPass, mergeLockState, selectedMac]);

  // Wysyła komendę do centralki (odblokuj, przełącz użytkownika, itd.),
  // obsługując zarówno tryb chmurowy jak i lokalny (AP centralki).
  const executeCommand = (endpoint, payload = null) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    if (endpoint === '/api/unlock') {
      pendingUnlockSinceRef.current = Date.now();
      setLockState(prevState => ({ ...prevState, lock: 'pending' }));
    }
    if (isLocalMode) {
      const localUrl = buildLocalRequestUrl(endpoint, payload, localAdminPass);
      fetch(localUrl)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP status ${res.status}`);
          fetchStatus();
        })
        .catch(() => {
          Alert.alert('Błąd', 'Nie udało się połączyć z centralką w trybie lokalnym.');
        });
    } else {
      // W trybie multi-device dołączamy mac wybranej centralki: dla GET jako
      // parametr URL, dla POST jako pole body — endpoint sam wybierze
      // właściwe urządzenie (lub padnie na pierwsze, jeśli mac pominięty).
      const isGet = !payload;
      const url = isGet && selectedMac
        ? `${backendUrl}${endpoint}${endpoint.includes('?') ? '&' : '?'}mac=${encodeURIComponent(selectedMac)}`
        : `${backendUrl}${endpoint}`;
      const finalPayload = (!isGet && selectedMac) ? { ...payload, mac: selectedMac } : payload;

      fetch(url, {
        method: isGet ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
        },
        body: finalPayload ? JSON.stringify(finalPayload) : undefined
      })
        .then(async (res) => {
          if (!res.ok) {
            // Serwer odsyła KONKRETNY powód (np. limit pakietu: 403 z {error, limit, used, tier}).
            // Wcześniej wszystko lądowało pod „Nie udało się wysłać komendy do centralki",
            // co sugerowało awarię sprzętu, choć realnie chodziło o limit licencji.
            const data = await res.json().catch(() => ({}));
            const err = new Error(data.error || `Błąd serwera (HTTP ${res.status})`);
            err.isLimit = res.status === 403 && (data.limit !== undefined || data.feature !== undefined);
            throw err;
          }
          fetchStatus();
        })
        .catch((e) => {
          const msg = e?.message || 'Nie udało się wysłać komendy do centralki.';
          Alert.alert(e?.isLimit ? 'Limit pakietu' : 'Błąd', msg);
        });
    }
  };

  // --- Zarządzanie wieloma centralkami (multi-device) ---
  // Zmiana nazwy przez własny modal z TextInput (nie Alert.prompt, który działa
  // tylko na iOS). Klient może nazwać każdą centralkę dowolnie, np. "Garaż".
  const handleRenameDevice = (mac, currentName) => {
    setRenameDeviceInput(currentName || '');
    setRenameDeviceMac(mac);
  };

  const submitRenameDevice = () => {
    const newName = renameDeviceInput.trim();
    if (!newName) { Alert.alert('Błąd', 'Podaj nazwę centralki.'); return; }
    fetch(`${backendUrl}/api/devices/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}) },
      body: JSON.stringify({ mac: renameDeviceMac, name: newName })
    })
      .then((res) => { if (!res.ok) throw new Error(); setRenameDeviceMac(null); setRenameDeviceInput(''); fetchStatus(); })
      .catch(() => Alert.alert('Błąd', 'Nie udało się zmienić nazwy centralki.'));
  };

  // --- Deregistracja centralki: twarde odłączenie + reset (tylko właściciel,
  //     potwierdzane kodem z maila). Działa na aktualnie wybranej centralce. ---
  const startDeregister = () => {
    setDeregCodeInput('');
    setDeregStep('request');
    setDeregVisible(true);
  };

  const requestDeregisterCode = () => {
    if (!selectedMac) return;
    setDeregBusy(true);
    fetch(`${backendUrl}/api/devices/deregister_request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}) },
      body: JSON.stringify({ mac: selectedMac })
    })
      .then((res) => res.json().then(d => ({ ok: res.ok, d })))
      .then(({ ok, d }) => {
        setDeregBusy(false);
        if (ok) setDeregStep('code');
        else Alert.alert('Błąd', d.error || 'Nie udało się wysłać kodu.');
      })
      .catch(() => { setDeregBusy(false); Alert.alert('Błąd', 'Brak połączenia.'); });
  };

  const submitDeregisterConfirm = () => {
    const code = deregCodeInput.trim();
    if (!code) { Alert.alert('Błąd', 'Wpisz kod z maila.'); return; }
    setDeregBusy(true);
    fetch(`${backendUrl}/api/devices/deregister_confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}) },
      body: JSON.stringify({ mac: selectedMac, code })
    })
      .then((res) => res.json().then(d => ({ ok: res.ok, d })))
      .then(({ ok, d }) => {
        setDeregBusy(false);
        if (ok) {
          setDeregVisible(false); setDeregCodeInput('');
          if (selectedMac) setSelectedMac('');
          Alert.alert('Odłączono', 'Centralka została odłączona i zresetowana. Wróci do trybu konfiguracji CTRLABLE_SETUP — aby użyć jej ponownie, skonfiguruj ją od nowa.');
          fetchStatus();
        } else Alert.alert('Błąd', d.error || 'Nieprawidłowy kod.');
      })
      .catch(() => { setDeregBusy(false); Alert.alert('Błąd', 'Brak połączenia.'); });
  };

  // --- Wielu administratorów na jeden zamek (zapraszanie: zakładka Zespół) ---
  // Akceptacja zaproszenia kodem — modal z TextInput (cross-platform). Główną
  // ścieżką jest link z maila, ale istniejące konta wpisują kod tutaj.
  const handleAcceptInvite = () => {
    setAcceptCodeInput('');
    setAcceptCodeVisible(true);
  };

  const submitAcceptCode = () => {
    const code = acceptCodeInput.trim();
    if (!code) { Alert.alert('Błąd', 'Wpisz kod zaproszenia.'); return; }
    fetch(`${backendUrl}/api/devices/accept_invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}) },
      body: JSON.stringify({ code })
    })
      .then((res) => res.json().then(d => ({ ok: res.ok, d })))
      .then(({ ok, d }) => {
        if (ok) { setAcceptCodeVisible(false); setAcceptCodeInput(''); Alert.alert('Sukces', 'Masz teraz dostęp do tej centralki.'); fetchStatus(); }
        else Alert.alert('Błąd', d.error || 'Nieprawidłowy kod.');
      })
      .catch(() => Alert.alert('Błąd', 'Brak połączenia.'));
  };

  // --- Zakładka "Zespół": zarządzanie współadministratorami per centralka ---
  const [teamByMac, setTeamByMac] = useState({});       // { MAC: [ {accountId, email, since} ] }
  const [inviteEmails, setInviteEmails] = useState({}); // { MAC: 'wpisywany e-mail' }
  const [teamLoading, setTeamLoading] = useState(false);
  const [teamBusyMac, setTeamBusyMac] = useState('');   // MAC, dla którego trwa wysyłka zaproszenia

  // --- Zakładka "Pakiet": licencja + zużycie (czyta /api/license) ---
  const [license, setLicense] = useState(null);          // { tier, limits, usage[], devicesUsed, validUntil, expired }
  const [licenseLoading, setLicenseLoading] = useState(false);
  const [licenseKeyInput, setLicenseKeyInput] = useState('');
  const [licenseBusy, setLicenseBusy] = useState(false);

  // --- Filtrowanie/wyszukiwanie w logach ---
  const [isLogSearchMode, setIsLogSearchMode] = useState(false);
  const [logSearchQuery, setLogSearchQuery] = useState('');
  const [logSearchCategory, setLogSearchCategory] = useState(''); // '' = wszystkie
  const [logSearchFrom, setLogSearchFrom] = useState('');
  const [logSearchTo, setLogSearchTo] = useState('');
  const [logSearchResults, setLogSearchResults] = useState([]);
  const [logSearchTotal, setLogSearchTotal] = useState(0);
  const [logSearchLoading, setLogSearchLoading] = useState(false);

  const LOG_CATEGORIES = [
    { key: '', label: 'Wszystkie', color: '#666' },
    { key: 'entries', label: '🚪 Wejścia', color: '#81c784' },
    { key: 'security', label: '⚠️ Bezpieczeństwo', color: '#e57373' },
    { key: 'provisioning', label: '⚙️ Konfiguracja', color: '#64b5f6' },
    { key: 'connections', label: '🔄 Aktualizacje', color: '#ffb300' }, // wyraźnie inny odcień niż szary "brak kategorii"
  ];

  const runLogSearch = (append = false) => {
    setLogSearchLoading(true);
    const params = new URLSearchParams();
    if (selectedMac) params.set('mac', selectedMac);
    if (logSearchQuery.trim()) params.set('q', logSearchQuery.trim());
    if (logSearchCategory) params.set('category', logSearchCategory);
    if (logSearchFrom.trim()) params.set('from', logSearchFrom.trim());
    if (logSearchTo.trim()) params.set('to', logSearchTo.trim());
    params.set('limit', '50');
    params.set('offset', append ? String(logSearchResults.length) : '0');

    fetch(`${backendUrl}/api/logs/search?${params.toString()}`, {
      headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
    })
      .then((res) => res.json())
      .then((d) => {
        setLogSearchTotal(d.total || 0);
        setLogSearchResults(append ? [...logSearchResults, ...(d.logs || [])] : (d.logs || []));
        setLogSearchLoading(false);
      })
      .catch(() => setLogSearchLoading(false));
  };

  // Pobiera listę współadministratorów dla wszystkich centralek, których jestem
  // WŁAŚCICIELEM (tylko właściciel widzi/zarządza adminami danego urządzenia).
  const loadTeam = () => {
    const owned = (devices || []).filter((d) => d.isOwner);
    if (owned.length === 0) { setTeamByMac({}); return; }
    setTeamLoading(true);
    Promise.all(owned.map((d) =>
      fetch(`${backendUrl}/api/devices/shared_users?mac=${encodeURIComponent(d.mac)}`, {
        headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
      })
        .then((res) => res.json())
        .then((j) => ({ mac: d.mac, admins: j.admins || [] }))
        .catch(() => ({ mac: d.mac, admins: [] }))
    ))
      .then((results) => {
        const map = {};
        results.forEach((r) => { map[r.mac] = r.admins; });
        setTeamByMac(map);
        setTeamLoading(false);
      })
      .catch(() => setTeamLoading(false));
  };

  // --- Pakiet/licencja ---
  const TIER_LABELS = { free: 'Bez licencji', silver: 'Silver', gold: 'Gold', individual: 'Indywidualna' };
  const tierLabel = (t) => TIER_LABELS[t] || t || '—';

  const loadLicense = () => {
    setLicenseLoading(true);
    fetch(`${backendUrl}/api/license`, {
      headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
    })
      .then((res) => res.json())
      .then((d) => { setLicense(d); setLicenseLoading(false); })
      .catch(() => setLicenseLoading(false));
  };

  const submitLicenseKey = () => {
    const key = (licenseKeyInput || '').trim();
    if (!key) { Alert.alert('Błąd', 'Wklej klucz licencyjny.'); return; }
    setLicenseBusy(true);
    fetch(`${backendUrl}/api/license/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}) },
      body: JSON.stringify({ key })
    })
      .then((res) => res.json().then((d) => ({ ok: res.ok, d })))
      .then(({ ok, d }) => {
        setLicenseBusy(false);
        if (ok) {
          Alert.alert('Aktywowano', `Pakiet: ${tierLabel(d.tier)}. Limity zaktualizowane.`);
          setLicenseKeyInput('');
          loadLicense();
        } else {
          Alert.alert('Błąd', d.error || 'Nie udało się aktywować klucza.');
        }
      })
      .catch(() => { setLicenseBusy(false); Alert.alert('Błąd', 'Brak połączenia z serwerem.'); });
  };

  // Wysyła zaproszenie e-mailem (serwer generuje link). Prawdziwy TextInput,
  // nie Alert.prompt — ten ostatni działa tylko na iOS.
  const submitInvite = (mac) => {
    const emailToInvite = (inviteEmails[mac] || '').trim();
    if (!emailToInvite || !emailToInvite.includes('@')) {
      Alert.alert('Błąd', 'Podaj prawidłowy adres e-mail.');
      return;
    }
    setTeamBusyMac(mac);
    fetch(`${backendUrl}/api/devices/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}) },
      body: JSON.stringify({ mac, email: emailToInvite })
    })
      .then((res) => res.json().then((d) => ({ ok: res.ok, d })))
      .then(({ ok, d }) => {
        setTeamBusyMac('');
        if (ok) {
          Alert.alert('Wysłano', `Zaproszenie wysłane na ${emailToInvite}. Osoba otrzyma link do utworzenia konta i uzyska dostęp po rejestracji.`);
          setInviteEmails((prev) => ({ ...prev, [mac]: '' }));
        } else {
          Alert.alert('Błąd', d.error || 'Nie udało się wysłać zaproszenia.');
        }
      })
      .catch(() => { setTeamBusyMac(''); Alert.alert('Błąd', 'Brak połączenia.'); });
  };

  // Odbiera dostęp adminowi i odświeża listę zespołu (zakładka Zespół).
  const revokeFromTeam = (mac, targetAccountId, adminEmail) => {
    Alert.alert('Odbierz dostęp', `Czy na pewno odebrać dostęp administratorowi ${adminEmail}?`, [
      { text: 'Anuluj', style: 'cancel' },
      { text: 'Odbierz', style: 'destructive', onPress: () => {
        fetch(`${backendUrl}/api/devices/revoke_share`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}) },
          body: JSON.stringify({ mac, accountId: targetAccountId })
        })
          .then(() => loadTeam())
          .catch(() => Alert.alert('Błąd', 'Nie udało się odebrać dostępu.'));
      }}
    ]);
  };

  // --- Sprawdzanie i wykonywanie aktualizacji OTA ---
  const handleCheckUpdate = () => {
    setOtaState('checking');
    fetch(`${backendUrl}/api/firmware/version`)
      .then((res) => res.json())
      .then((data) => {
        setLatestVersion(data.latestVersion || '');
        const latestId = data.releaseId || 0;
        const deviceId = lockState.deviceReleaseId || 0;
        const isUpToDate = (latestId > 0 && deviceId > 0)
          ? (deviceId >= latestId)
          : ((lockState.version || '').replace(/^v/, '') === (data.latestVersion || '').replace(/^v/, ''));
        setOtaState(isUpToDate ? 'up-to-date' : 'available');
      })
      .catch(() => {
        setOtaState('idle');
        Alert.alert('Błąd', 'Nie udało się sprawdzić dostępności aktualizacji.');
      });
  };

  const handleExecuteUpdate = () => {
    setOtaState('downloading_server');
    fetch(`${backendUrl}/api/ota/push`, {
      headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
    })
      .then((res) => {
        if (!res.ok) throw new Error('OTA push failed');
        setOtaState('flashing_device');
        const checkInterval = setInterval(() => {
          fetch(`${backendUrl}/api/data`, { headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {} })
            .then((r) => r.json())
            .then((data) => {
              const deviceIdNow = data.deviceReleaseId || 0;
              const latestReleaseId = data.latestReleaseId || 0;
              if (latestReleaseId > 0 && deviceIdNow >= latestReleaseId) {
                clearInterval(checkInterval);
                setOtaState('success');
                setTimeout(() => setOtaState('idle'), 5000);
              }
            })
            .catch(() => {});
        }, 2000);
      })
      .catch(() => {
        setOtaState('available');
        Alert.alert('Błąd', 'Nie udało się rozpocząć aktualizacji.');
      });
  };

  // --- Zapis ustawień systemowych (zmiana Wi-Fi centralki) ---
  const handleSaveSystemSettings = () => {
    if (!settingsSsid) return Alert.alert('Błąd', 'Wprowadź nazwę sieci Wi-Fi.');
    fetch(`${backendUrl}/api/settings/wifi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}) },
      body: JSON.stringify({ wifiSSID: settingsSsid, wifiPass: settingsWifiPass })
    })
      .then((res) => {
        if (!res.ok) throw new Error('Save failed');
        Alert.alert('Zapisano', 'Centralka zrestartuje się i połączy z nową siecią Wi-Fi.');
      })
      .catch(() => Alert.alert('Błąd', 'Nie udało się zapisać ustawień.'));
  };

  // --- Czas otwarcia rygla (tylko właściciel) ---
  // Zapis optymistyczny: podświetlamy wybór od razu, a przy błędzie cofamy do wartości
  // z serwera. Centralka pobierze nową wartość przy najbliższym pollu (auto_lock_delay).
  // mac = KTÓREJ centralki dotyczy zmiana (moduł „Centralki" pokazuje wszystkie).
  // Optymistycznie podświetlamy wybór per MAC, przy błędzie cofamy.
  const saveAutoLockSeconds = (mac, seconds) => {
    if (!mac) return;
    setAutoLockSeconds(prev => ({ ...(prev || {}), [mac]: seconds }));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    fetch(`${backendUrl}/api/devices/auto_lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}) },
      body: JSON.stringify({ mac, seconds })
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Nie udało się zapisać czasu otwarcia.');
        fetchStatus();
      })
      .catch((e) => {
        setAutoLockSeconds(prev => { const next = { ...(prev || {}) }; delete next[mac]; return next; });
        Alert.alert('Nie zapisano', e.message);
      });
  };

  // --- Tryb nauki nowej karty RFID ---
  // Nazwa MUSI polecieć w URL-u: /api/toggle_learn to GET (executeCommand robi POST
  // dopiero gdy dostanie payload), a serwer czyta ją z query.username i dopiero stamtąd
  // trafia w odpowiedzi polla do centralki. Wcześniej nazwa z pola była po cichu gubiona
  // i każda karta lądowała jako „Nowy Użytkownik".
  const handleToggleLearn = () => {
    const label = newName.trim();
    const isLeaving = lockState.mode === 'Uczenie';
    const endpoint = (!isLeaving && label)
      ? `/api/toggle_learn?username=${encodeURIComponent(label)}`
      : '/api/toggle_learn';
    executeCommand(endpoint);
    if (!isLeaving) setNewName('');
  };

  // --- Zmiana nazwy użytkownika (karty RFID) — jednolity wzorzec z PIN-ami:
  // edycja inline w wierszu, bez wyskakującego okienka.
  const cardRename = () => {
    if (!cardRenameName.trim()) return;
    executeCommand('/api/user/rename', { ...(cardRenameRef || {}), name: cardRenameName.trim() });
    setCardRenameIdx(null); setCardRenameRef(null); setCardRenameName('');
  };

  // --- Rejestracja tokena push notifications ---
  const registerForPushNotificationsAsync = async (aid) => {
    try {
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;
      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }
      if (finalStatus !== 'granted') return;

      const tokenData = await Notifications.getExpoPushTokenAsync();
      const token = tokenData.data;

      await fetch(`${backendUrl}/api/auth/save_push_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: aid, token })
      });
    } catch (e) {
      console.error('Push registration error:', e.message);
    }
  };

  // --- Krok 2: weryfikacja 6-cyfrowego kodu resetu hasła ---
  const handleVerifyResetCode = () => {
    if (!resetCode) return Alert.alert('Błąd', 'Wprowadź kod autoryzacyjny.');
    setIsAuthenticating(true);
    fetch(`${backendUrl}/api/auth/verify_reset_code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), code: resetCode.trim() })
    })
      .then((res) => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        setIsAuthenticating(false);
        if (ok && data.valid) {
          setResetStep(3);
        } else {
          Alert.alert('Błąd', data.error || 'Kod jest nieprawidłowy lub wygasł.');
        }
      })
      .catch(() => {
        setIsAuthenticating(false);
        Alert.alert('Błąd sieci', 'Spróbuj ponownie.');
      });
  };

  // --- Krok 3: zapis nowego hasła ---
  const handleConfirmPasswordReset = () => {
    if (!newPassword || newPassword.length < 6) {
      return Alert.alert('Błąd', 'Hasło musi mieć co najmniej 6 znaków.');
    }
    if (newPassword !== confirmNewPassword) {
      return Alert.alert('Błąd', 'Hasła nie są identyczne.');
    }
    setIsAuthenticating(true);
    fetch(`${backendUrl}/api/auth/confirm_password_reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), code: resetCode.trim(), newPassword })
    })
      .then((res) => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        setIsAuthenticating(false);
        if (ok) {
          Alert.alert('Sukces', 'Hasło zostało zmienione. Zaloguj się ponownie.');
          setResetStep(1);
          setResetCode('');
          setNewPassword('');
          setConfirmNewPassword('');
        } else {
          Alert.alert('Błąd', data.error || 'Nie udało się zmienić hasła.');
        }
      })
      .catch(() => {
        setIsAuthenticating(false);
        Alert.alert('Błąd sieci', 'Spróbuj ponownie.');
      });
  };

  useEffect(() => {
    // Rygiel jest otwarty tylko ~3 s (autoLockDelayMs), a łańcuch opóźnień to
    // poll centralki (~1 s) + poll aplikacji. Przy 3 s w spoczynku apka pokazywała
    // „Otwarto" dopiero PO faktycznym zamknięciu (albo gubiła zdarzenie).
    // 1,2 s mieści się w oknie otwarcia i nadal nie zalewa serwera.
    const dynamicIntervalTime = (lockState.lock === true || lockState.lock === 'pending') ? 500 : 1200;

    const interval = setInterval(fetchStatus, dynamicIntervalTime);
    return () => clearInterval(interval);
  }, [isConfigured, accountId, isLocalMode, fetchStatus, lockState.lock]);

  // 🌟 EKRAN POWITALNY: pokazujemy go zawsze przy starcie aplikacji, dopóki
  // (a) AsyncStorage nie skończy odczytu sesji ORAZ (b) animacja logo nie
  // dograła do końca - niezależnie od tego, czy użytkownik trafi potem na
  // ekran logowania czy prosto na Dashboard.
  if (isLoading || !splashAnimationDone) {
    return (
      <LoaderAnimation
        logoSource={require('./assets/ctrlable_logo.png')}
        onFinished={() => setSplashAnimationDone(true)}
      />
    );
  }

  if (!isConfigured) {
    // Dynamiczne dopasowanie nagłówka karty w zależności od etapu połączenia
    const getAuthTitle = () => {
      if (authStep === 'mode') return 'Uruchomienie Centralki';
      if (authStep === 'account_choice') return 'Konto CTRLABLE';
      if (authStep === 'connect') return 'Połączenie Węzła';
      if (authStep === 'onboarding') return initMode === 'offline' ? 'Tryb Lokalny' : 'Inicjalizacja Centralki';
      if (authStep === 'forgot') return `Odzyskiwanie [Krok ${resetStep}/3]`;
      if (authStep === 'register') return 'Rejestracja Konta Master';
      if (authStep === 'verify') return 'Weryfikacja E-mail';
      return 'Autoryzacja CTRLABLE';
    };

    /* Dopiero pod spodem leci Twój obecny return z widokami aplikacji
    return (
      <View style={styles.container}>
      </View>
    ); */

    return (
      <SafeAreaView style={styles.darkContainer}>
        <View style={styles.authCard}>
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={handleLogoTap}
            onLongPress={() => {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              // DEV BACKDOOR: Przeskakujemy konfigurację prosto do głównego Dashboardu!
              setIsConfigured(true);
              Alert.alert("Tryb Deweloperski", "Uruchomiono tryb bypass sieciowego. Witamy w Dashboardzie!");
            }}
            delayLongPress={2000}
          >
            <BrandIcon size={64} variant="dark" style={styles.authLogoIcon} />
          </TouchableOpacity>
          <Text style={styles.titleText}>{getAuthTitle()}</Text>

          {showInstallerMenu && (
            <View style={styles.installerBoxContainer}>
              <Text style={styles.installerTitleText}>🛠️ Core Infrastructure Router Configuration</Text>
              <TextInput style={[styles.inputField, { borderColor: '#e11d48' }]} placeholder="e.g. 192.168.0.200:3000" placeholderTextColor="#666" value={installerUrlInput} onChangeText={setInstallerUrlInput} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', width: '100%' }}>
                <TouchableOpacity style={[styles.inlineBtn, { backgroundColor: '#333' }]} onPress={() => setShowInstallerMenu(false)}><Text style={styles.btnText}>Close</Text></TouchableOpacity>
                <TouchableOpacity style={[styles.inlineBtn, { backgroundColor: '#e11d48' }]} onPress={saveInstallerConfig}><Text style={styles.btnText}>Apply Node</Text></TouchableOpacity>
              </View>
            </View>
          )}

          {/* KROK 0: WYBÓR TRYBU — online (chmura) vs offline (lokalny) */}
          {authStep === 'mode' && (
            <>
              <Text style={[styles.inputLabelText, { textAlign: 'center', marginBottom: 24, alignSelf: 'center', color: '#aaa', lineHeight: 18 }]}>
                Jak chcesz uruchomić centralkę? Tryb chmurowy daje konto, zdalne zarządzanie, logi i aktualizacje. Tryb lokalny działa bez internetu i bez konta — zarządzasz przez Wi-Fi centralki.
              </Text>

              <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: '#5c33cf', marginVertical: 8 }]} onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                setInitMode('online');
                setErrorMessage('');
                setAuthStep('account_choice');
              }}>
                <Text style={styles.btnText}>☁️ Tryb chmurowy (online)</Text>
              </TouchableOpacity>

              <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: '#1c1917', borderWidth: 1, borderColor: '#444', marginVertical: 8 }]} onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                setInitMode('offline');
                setErrorMessage('');
                setDetectedDevice(false);
                setAuthStep('connect');
              }}>
                <Text style={styles.btnText}>🔌 Tryb lokalny (offline)</Text>
              </TouchableOpacity>
            </>
          )}

          {/* KROK 0b: KONTO — masz już konto czy zakładasz nowe? (tylko online) */}
          {authStep === 'account_choice' && (
            <>
              <Text style={[styles.inputLabelText, { textAlign: 'center', marginBottom: 24, alignSelf: 'center', color: '#aaa', lineHeight: 18 }]}>
                Masz już konto CTRLABLE? Zaloguj się, aby przypiąć centralkę. Jeśli nie — załóż nowe (potwierdzimy e-mail kodem).
              </Text>

              <TouchableOpacity style={[styles.primaryBtn, { marginVertical: 8 }]} onPress={() => { setErrorMessage(''); setAuthStep('login'); }}>
                <Text style={styles.btnText}>Mam konto — zaloguj się</Text>
              </TouchableOpacity>

              <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: '#2e7d32', marginVertical: 8 }]} onPress={() => { setErrorMessage(''); setIsPrivacyAccepted(false); setAuthStep('register'); }}>
                <Text style={styles.btnText}>Załóż nowe konto</Text>
              </TouchableOpacity>

              <TouchableOpacity style={{ marginTop: 18 }} onPress={() => setAuthStep('mode')}>
                <Text style={{ color: '#64b5f6', fontWeight: 'bold', fontSize: 13, textAlign: 'center' }}>⬅ Zmień tryb</Text>
              </TouchableOpacity>
            </>
          )}

          {/* =========================================================================
              KROK 1: RYGORYSTYCZNY EKRAN STARTOWY Z INTEGRACJĄ SYSTEMOWĄ WI-FI
              ========================================================================= */}
          {authStep === 'connect' && (
            <>
              <Text style={[styles.inputLabelText, { textAlign: 'center', marginBottom: 24, alignSelf: 'center', color: '#aaa', lineHeight: 18 }]}>
                {initMode === 'offline'
                  ? 'Tryb lokalny. Podłącz telefon do sieci Wi-Fi centralki (CTRLABLE_SETUP), aby ją zainicjalizować.'
                  : 'Ostatni krok: dodaj centralkę. Podłącz telefon do sieci Wi-Fi centralki (CTRLABLE_SETUP) i sprawdź połączenie.'}
              </Text>

              {isScanning ? (
                <View style={{ alignItems: 'center', marginVertical: 24, width: '100%' }}>
                  <LoadingPulse size={48} />
                  <Text style={{ color: '#64b5f6', fontWeight: 'bold', fontSize: 16, marginTop: 10, marginBottom: 6 }}>Sprawdzanie połączenia z centralką...</Text>
                  <Text style={{ color: '#555', fontSize: 12, textAlign: 'center' }}>
                    Pukam do bramy 192.168.4.1 (sieć CTRLABLE_SETUP)...
                  </Text>
                </View>
              ) : (
                <>
                  {/* Instrukcja RĘCZNEGO połączenia — w Expo Go apka nie może sama
                      przełączyć Wi-Fi, więc prowadzimy użytkownika krok po kroku,
                      a potem walidujemy realne połączenie fetchem do 192.168.4.1. */}
                  <View style={{ width: '100%', backgroundColor: '#141414', borderRadius: 14, borderWidth: 1, borderColor: '#262626', padding: 18, marginVertical: 10 }}>
                    <Text style={{ color: '#ffb300', fontWeight: 'bold', fontSize: 14, marginBottom: 12 }}>Podłącz telefon do centralki:</Text>
                    <Text style={{ color: '#ccc', fontSize: 13, lineHeight: 20, marginBottom: 6 }}>1.  Upewnij się, że centralka jest zasilona i na ekranie ma „CTRLABLE_SETUP".</Text>
                    <Text style={{ color: '#ccc', fontSize: 13, lineHeight: 20, marginBottom: 6 }}>2.  Wejdź w Ustawienia Wi-Fi telefonu i połącz się z siecią <Text style={{ color: '#64b5f6', fontWeight: 'bold' }}>CTRLABLE_SETUP</Text>.</Text>
                    <Text style={{ color: '#ccc', fontSize: 13, lineHeight: 20 }}>3.  Wróć do aplikacji i naciśnij „Sprawdź połączenie".</Text>
                  </View>

                  <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: '#2a2a2a', marginVertical: 6 }]} onPress={() => {
                    // Best-effort otwarcie systemowych ustawień Wi-Fi (zależne od OS)
                    if (Platform.OS === 'android') {
                      Linking.sendIntent('android.settings.WIFI_SETTINGS').catch(() => Linking.openSettings());
                    } else {
                      Linking.openURL('App-Prefs:root=WIFI').catch(() => Linking.openSettings());
                    }
                  }}>
                    <Text style={[styles.btnText, { color: '#ccc' }]}>Otwórz ustawienia Wi-Fi</Text>
                  </TouchableOpacity>

                  <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: '#5c33cf', marginVertical: 6 }]} onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    setErrorMessage(null);
                    setIsScanning(true);

                    // Walidacja: telefon musi być już w sieci CTRLABLE_SETUP — pukamy do bramy centralki.
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 3500);

                    fetch('http://192.168.4.1/', { signal: controller.signal })
                      .then(() => {
                        clearTimeout(timeoutId);
                        setIsScanning(false);
                        setDetectedDevice(true);
                        setAuthStep('onboarding'); // Sukces! Przechodzimy do karty konfiguracji
                        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                      })
                      .catch(() => {
                        clearTimeout(timeoutId);
                        setIsScanning(false);
                        setDetectedDevice(false);
                        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                        setErrorMessage("Nie widać centralki (192.168.4.1). Sprawdź, czy telefon jest połączony z siecią CTRLABLE_SETUP i czy centralka nadaje.");
                      });
                  }}>
                    <Text style={styles.btnText}>Sprawdź połączenie</Text>
                  </TouchableOpacity>
                </>
              )}

              {/* Nawigacja zależna od trybu/sesji: offline → zmień tryb; online zalogowany →
                  pomiń dodawanie i wejdź do aplikacji; online niezalogowany → wróć do konta. */}
              {initMode === 'offline' ? (
                <TouchableOpacity style={{ marginTop: 24 }} onPress={() => setAuthStep('mode')}>
                  <Text style={{ color: '#444', fontSize: 12, fontWeight: '600', textAlign: 'center' }}>⬅ Zmień tryb uruchomienia</Text>
                </TouchableOpacity>
              ) : authToken ? (
                <TouchableOpacity style={{ marginTop: 24 }} onPress={() => { resetUiToDefault(); setIsConfigured(true); }}>
                  <Text style={{ color: '#444', fontSize: 12, fontWeight: '600', textAlign: 'center' }}>Dodam centralkę później — przejdź do aplikacji ➔</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={{ marginTop: 24 }} onPress={() => setAuthStep('account_choice')}>
                  <Text style={{ color: '#444', fontSize: 12, fontWeight: '600', textAlign: 'center' }}>⬅ Wróć do konta</Text>
                </TouchableOpacity>
              )}
            </>
          )}

          {/* =========================================================================
              KROK 2: KARTA INICJALIZACJI CENTRALKI (DOSTĘPNA PO SPAROWANIU)
              ========================================================================= */}
          {authStep === 'onboarding' && (
            <>
              {initMode === 'offline' ? (
                <>
                  <Text style={[styles.inputLabelText, { textAlign: 'center', marginBottom: 20, alignSelf: 'center', color: '#ffb300', lineHeight: 18 }]}>
                    Tryb lokalny: centralka nigdy nie łączy się z internetem ani chmurą. Karty RFID i przycisk działają od razu, a zarządzasz nią przez sieć Wi-Fi centralki (CTRLABLE_SETUP). Konto nie jest potrzebne.
                  </Text>
                  <TouchableOpacity
                    style={[styles.primaryBtn, { backgroundColor: '#1c1917', borderWidth: 1, borderColor: '#444' }, isAuthenticating ? { opacity: 0.6 } : null]}
                    disabled={isAuthenticating}
                    onPress={handleOfflineSetup}
                  >
                    <Text style={styles.btnText}>🔌 Uruchom w trybie lokalnym</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <Text style={[styles.inputLabelText, { textAlign: 'center', marginBottom: 20, alignSelf: 'center', color: '#ffb300', lineHeight: 18 }]}>
                    Upewnij się, że telefon jest połączony z Wi-Fi: CTRLABLE_SETUP. Podaj dane swojej domowej sieci — centralka wpisze się do niej i zgłosi do Twojego konta ({email}).
                  </Text>

                  <Text style={styles.inputLabelText}>Nazwa domowej sieci Wi-Fi (SSID):</Text>
                  <TextInput style={styles.inputField} placeholder="Wpisz nazwę sieci Wi-Fi" placeholderTextColor="#444" value={settingsSsid} onChangeText={setSettingsSsid} />

                  <Text style={styles.inputLabelText}>Hasło do domowej sieci Wi-Fi:</Text>
                  <TextInput style={styles.inputField} placeholder="Wpisz hasło Wi-Fi" placeholderTextColor="#444" secureTextEntry value={settingsWifiPass} onChangeText={setSettingsWifiPass} />

                  <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: '#2e7d32', marginTop: 12 }, isAuthenticating ? { opacity: 0.6 } : null]} disabled={isAuthenticating} onPress={async () => {
                    // NAJPIERW sonda: czy telefon NAPRAWDĘ jest w sieci CTRLABLE_SETUP?
                    // Bez tego konfiguracja leciała „w próżnię" (fetch padał, a że .catch=.then,
                    // apka i tak mówiła „wysłano" — centralka nigdy nie dostawała danych).
                    if (!settingsSsid) { setErrorMessage('Podaj nazwę sieci Wi-Fi.'); return; }
                    // STRAŻNIK: bez e-maila właściciela centralka nigdy się nie zarejestruje
                    // (serwer rejestruje TYLKO poll z niepustym &email=). Wcześniej pusty stan
                    // `email` (po przeładowaniu bundla) cicho psuł całą inicjalizację.
                    const ownerEmail = (email || (await AsyncStorage.getItem('@lock_account_email')) || '').trim().toLowerCase();
                    if (!ownerEmail) {
                      Alert.alert('Brak e-maila konta', 'Nie znam adresu e-mail Twojego konta. Zaloguj się ponownie i spróbuj dodać centralkę jeszcze raz.');
                      return;
                    }
                    if (!email) setEmail(ownerEmail);
                    setIsAuthenticating(true);
                    setErrorMessage('');
                    try {
                      const probe = new AbortController();
                      const probeTimer = setTimeout(() => probe.abort(), 3500);
                      await fetch('http://192.168.4.1/', { signal: probe.signal });
                      clearTimeout(probeTimer);
                    } catch (e) {
                      setIsAuthenticating(false);
                      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                      Alert.alert(
                        'Brak łączności z centralką',
                        'Telefon nie widzi centralki pod 192.168.4.1. Połącz się w ustawieniach Wi-Fi z siecią CTRLABLE_SETUP i spróbuj ponownie.'
                      );
                      return;
                    }
                    setIsAuthenticating(false);
                    // Firmware po odebraniu GET-a robi WiFi.begin (AP+STA) → SoftAP przeskakuje na
                    // kanał sieci domowej i telefon WYPADA z CTRLABLE_SETUP, więc fetch prawie zawsze
                    // się ODRZUCA, mimo że GET dotarł i ustawienia zapisano. .then i .catch = to samo.
                    // Konto JUŻ istnieje (użytkownik zalogowany/zweryfikowany) → reg_pass PUSTE;
                    // owner = e-mail zalogowanego konta. Firmware NIE zakłada już konta.
                    const finishSent = () => {
                      Alert.alert(
                        "Konfiguracja wysłana ✓",
                        "Centralka zapisała ustawienia i restartuje się, aby połączyć się z Twoją siecią. Za chwilę zgłosi się do chmury i pojawi się na liście urządzeń.\n\nPrzełącz telefon z powrotem na swój internet (Wi-Fi domowe lub dane komórkowe)."
                      );
                      resetUiToDefault();
                      setIsConfigured(true);
                    };
                    fetch(`http://192.168.4.1/save_setup?s=${encodeURIComponent(settingsSsid)}&p=${encodeURIComponent(settingsWifiPass)}&m=${encodeURIComponent(ownerEmail)}&reg_pass=&offline=0`)
                      .then(finishSent)
                      .catch(finishSent);
                  }}>
                    <Text style={styles.btnText}>Zapisz i połącz centralkę</Text>
                  </TouchableOpacity>
                </>
              )}

              <TouchableOpacity style={{ marginTop: 20 }} onPress={() => { setAuthStep('connect'); setDetectedDevice(false); }}>
                <Text style={{ color: '#64b5f6', fontWeight: 'bold', fontSize: 13, textAlign: 'center' }}>⬅ Powrót</Text>
              </TouchableOpacity>
            </>
          )}

          {/* =========================================================================
              KROK 3: PANEL LOGOWANIA (UKRYTY DLA OSÓB BEZ SPRZĘTU)
              ========================================================================= */}
          {authStep === 'login' && (
            <>
              <Text style={styles.inputLabelText}>Adres E-mail:</Text>
              <TextInput style={styles.inputField} placeholder="nazwa@domena.pl" keyboardType="email-address" autoCapitalize="none" placeholderTextColor="#444" editable={!isAuthenticating} value={email} onChangeText={setEmail} />

              <Text style={styles.inputLabelText}>Klucz Bezpieczeństwa (Hasło):</Text>
              <View style={{ width: '100%', position: 'relative' }}>
                <TextInput style={styles.inputField} placeholder="••••••••" placeholderTextColor="#444" secureTextEntry={secureLogin} editable={!isAuthenticating} value={password} onChangeText={setPassword} />
                <TouchableOpacity style={{ position: 'absolute', right: 14, top: 16 }} onPress={() => setSecureLogin(!secureLogin)}>
                  <Text style={{ color: '#64b5f6', fontWeight: 'bold' }}>{secureLogin ? "Pokaż" : "Ukryj"}</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity style={[styles.primaryBtn, isAuthenticating ? {backgroundColor: '#333'} : null]} onPress={handleSecurityLogin} disabled={isAuthenticating}>
                <Text style={styles.btnText}>{isAuthenticating ? 'Autoryzacja w węźle...' : 'Zaloguj się'}</Text>
              </TouchableOpacity>

              <TouchableOpacity style={{ marginTop: 20 }} onPress={() => { setAuthStep('forgot'); setResetStep(1); }}>
                <Text style={{ color: '#64b5f6', fontWeight: 'bold', fontSize: 13, textAlign: 'center' }}>Zapomniałeś hasła? Resetuj przez e-mail</Text>
              </TouchableOpacity>

              <TouchableOpacity style={{ marginTop: 14 }} onPress={() => { setIsPrivacyAccepted(false); setAuthStep('register'); }}>
                <Text style={{ color: '#aaa', fontSize: 13, textAlign: 'center' }}>Nie masz konta? Zarejestruj nową przestrzeń</Text>
              </TouchableOpacity>

              <TouchableOpacity style={{ marginTop: 24 }} onPress={() => setAuthStep('account_choice')}>
                <Text style={{ color: '#666', fontSize: 12, fontWeight: '600', textAlign: 'center' }}>⬅ Wróć</Text>
              </TouchableOpacity>
            </>
          )}

          {/* =========================================================================
              KROK 4: REJESTRACJA KONT (DOSTĘPNA TYLKO DLA WŁAŚCICIELI)
              ========================================================================= */}
          {authStep === 'register' && (
            <>
              <Text style={styles.inputLabelText}>Adres E-mail dla nowego konta:</Text>
              <TextInput style={styles.inputField} placeholder="nazwa@domena.pl" keyboardType="email-address" autoCapitalize="none" placeholderTextColor="#444" editable={!isAuthenticating} value={email} onChangeText={setEmail} />

              <Text style={styles.inputLabelText}>Klucz Bezpieczeństwa (Hasło):</Text>
              <TextInput style={styles.inputField} placeholder="Minimum 6 znaków" placeholderTextColor="#444" secureTextEntry editable={!isAuthenticating} value={password} onChangeText={setPassword} />

              <View style={styles.checkboxContainer}>
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={[styles.checkboxSquare, isPrivacyAccepted && styles.checkboxSquareChecked]}
                  onPress={() => setIsPrivacyAccepted(!isPrivacyAccepted)}
                >
                  {isPrivacyAccepted && <Text style={styles.checkboxCheckmark}>✓</Text>}
                </TouchableOpacity>

                <Text style={styles.checkboxLabel}>
                  Oświadczam, że zapoznałem się i akceptuję{' '}
                  <Text
                    style={styles.hyperlinkText}
                    onPress={() => Linking.openURL('https://ctrlable.pl/regulamin.html')}
                  >
                    Regulamin Serwisu
                  </Text>
                  {' '}oraz{' '}
                  <Text
                    style={styles.hyperlinkText}
                    onPress={() => Linking.openURL('https://ctrlable.pl/polityka-prywatnosci.html')}
                  >
                    Politykę Prywatności
                  </Text>
                  , w tym wyrażam zgodę na przetwarzanie moich danych osobowych (takich jak adres e-mail oraz historia zdarzeń otwarcia rygla) w celu realizacji usług systemu CTRLABLE Node.
                </Text>
              </View>

              <TouchableOpacity
                style={[styles.primaryBtn, (isAuthenticating || !isPrivacyAccepted) ? {backgroundColor: '#333'} : null]}
                onPress={() => {
                  if (!isPrivacyAccepted) {
                    Alert.alert("Wymagana zgoda", "Musisz zaakceptować Regulamin i Politykę Prywatności, aby kontynuować.");
                    return;
                  }
                  handleAccountRegistration(); // sam przełączy na 'verify' po code_sent
                }}
                disabled={isAuthenticating || !isPrivacyAccepted}
              >
                <Text style={styles.btnText}>Utwórz Przestrzeń Chmurową</Text>
              </TouchableOpacity>

              <TouchableOpacity style={{ marginTop: 20 }} onPress={() => setAuthStep('account_choice')}>
                <Text style={{ color: '#64b5f6', fontSize: 13, fontWeight: 'bold', textAlign: 'center' }}>⬅ Wstecz</Text>
              </TouchableOpacity>
            </>
          )}

          {/* KROK 4b: WERYFIKACJA E-MAIL — kod 6-cyfrowy → aktywacja konta → dodanie centralki */}
          {authStep === 'verify' && (
            <>
              <Text style={[styles.inputLabelText, { textAlign: 'center', marginBottom: 20, alignSelf: 'center', color: '#aaa', lineHeight: 18 }]}>
                Wpisz 6-cyfrowy kod, który wysłaliśmy na adres {email || 'Twój e-mail'}. Kod jest ważny 15 minut.
              </Text>

              <TextInput
                style={[styles.inputField, { textAlign: 'center', fontSize: 24, letterSpacing: 8, fontFamily: 'monospace' }]}
                placeholder="______"
                placeholderTextColor="#444"
                keyboardType="number-pad"
                maxLength={6}
                editable={!isAuthenticating}
                value={verifyCode}
                onChangeText={(t) => setVerifyCode(t.replace(/[^0-9]/g, ''))}
              />

              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: '#2e7d32', marginTop: 10 }, (isAuthenticating || verifyCode.length < 6) ? { backgroundColor: '#333' } : null]}
                onPress={verifyEmailCode}
                disabled={isAuthenticating || verifyCode.length < 6}
              >
                <Text style={styles.btnText}>{isAuthenticating ? 'Weryfikacja...' : 'Potwierdź kod'}</Text>
              </TouchableOpacity>

              <TouchableOpacity style={{ marginTop: 16 }} onPress={handleAccountRegistration} disabled={isAuthenticating}>
                <Text style={{ color: '#64b5f6', fontSize: 13, fontWeight: 'bold', textAlign: 'center' }}>Wyślij kod ponownie</Text>
              </TouchableOpacity>

              <TouchableOpacity style={{ marginTop: 14 }} onPress={() => { setVerifyCode(''); setAuthStep('account_choice'); }}>
                <Text style={{ color: '#666', fontSize: 12, fontWeight: '600', textAlign: 'center' }}>⬅ Anuluj</Text>
              </TouchableOpacity>
            </>
          )}

          {/* =========================================================================
              KROK 5: BEZPIECZNY RESET HASŁA
              ========================================================================= */}
          {authStep === 'forgot' && (
            <>
              {resetStep === 1 && (
                <>
                  <Text style={styles.inputLabelText}>Adres E-mail przypisany do centralki:</Text>
                  <TextInput style={styles.inputField} placeholder="nazwa@domena.pl" keyboardType="email-address" autoCapitalize="none" placeholderTextColor="#444" editable={!isAuthenticating} value={email} onChangeText={setEmail} />
                  <TouchableOpacity style={[styles.primaryBtn, isAuthenticating ? {backgroundColor: '#333'} : null]} onPress={handleForgotPasswordSubmit} disabled={isAuthenticating}>
                    <Text style={styles.btnText}>Wyślij Kod Autoryzacyjny</Text>
                  </TouchableOpacity>
                </>
              )}
              {resetStep === 2 && (
                <>
                  <Text style={styles.inputLabelText}>Wprowadź 6-cyfrowy kod autoryzacyjny:</Text>
                  <TextInput style={styles.inputField} placeholder="np. 482910" keyboardType="number-pad" autoCapitalize="none" maxLength={6} placeholderTextColor="#444" editable={!isAuthenticating} value={resetCode} onChangeText={setResetCode} />
                  <TouchableOpacity style={[styles.primaryBtn, isAuthenticating ? {backgroundColor: '#333'} : null]} onPress={handleVerifyResetCode} disabled={isAuthenticating}>
                    <Text style={styles.btnText}>Zweryfikuj</Text>
                  </TouchableOpacity>
                </>
              )}
              {resetStep === 3 && (
                <>
                  <Text style={styles.inputLabelText}>Nowe Hasło:</Text>
                  <TextInput style={styles.inputField} placeholder="••••••••" placeholderTextColor="#444" secureTextEntry={secureReset} editable={!isAuthenticating} value={newPassword} onChangeText={setNewPassword} />
                  <Text style={styles.inputLabelText}>Powtórz Nowe Hasło:</Text>
                  <TextInput style={styles.inputField} placeholder="••••••••" placeholderTextColor="#444" secureTextEntry={secureReset} editable={!isAuthenticating} value={confirmNewPassword} onChangeText={setConfirmNewPassword} />
                  <TouchableOpacity style={[styles.primaryBtn, isAuthenticating ? {backgroundColor: '#333'} : null]} onPress={() => {
                    handleConfirmPasswordReset();
                    setAuthStep('login');
                  }} disabled={isAuthenticating}>
                    <Text style={styles.btnText}>Zapisz Nowy Klucz Master</Text>
                  </TouchableOpacity>
                </>
              )}
              <TouchableOpacity style={{ marginTop: 20 }} onPress={() => setAuthStep('login')}>
                <Text style={{ color: '#aaa', fontSize: 13, textAlign: 'center' }}>Anuluj operację</Text>
              </TouchableOpacity>
            </>
          )}

          {errorMessage ? <Text style={styles.errorBanner}>{errorMessage}</Text> : null}
        </View>
      </SafeAreaView>
    );
  }


  return (
    <SafeAreaView style={styles.darkContainer}>
      <View style={styles.navigationHeaderBar}>
        <TouchableOpacity style={styles.burgerIconTouchContainer} onPress={toggleBurgerMenu}>
          <View style={styles.burgerStripeLine} />
          <View style={[styles.burgerStripeLine, { marginVertical: 5 }]} /><View style={styles.burgerStripeLine} />
        </TouchableOpacity>
        <View style={styles.headerBrandRow}>
          <Animated.View style={{ opacity: headerLogoOpacity, marginRight: 8, transform: [{ scale: headerLogoOpacity }] }}>
            <BrandIcon size={24} variant="dark" />
          </Animated.View>
          <Text style={styles.headerTitleText}>CTRLABLE NODE</Text>
        </View>
        <View style={{ width: 24 }} />
        </View>


        <View style={{ flex: 1 }}>
          {currentScreen === 'dashboard' && (
            <ScrollView contentContainerStyle={styles.scrollWrapper}>
              <Text style={styles.screenHeaderText}>📱 Dashboard</Text>

              {/* ── PRZEŁĄCZNIK CENTRALEK ── tylko wybór urządzenia do zdalnego otwierania.
                  Widoczny dopiero przy 2+ centralkach — przy jednej nie ma czego przełączać.
                  Zarządzanie (nazwy, czas otwarcia, administratorzy) jest w module „Centralki". */}
              {!isLocalMode && devices.length > 1 && (
                <TouchableOpacity
                  style={{ backgroundColor: '#16161a', borderWidth: 1, borderColor: '#2a2a30', borderRadius: 10, padding: 12, marginBottom: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
                  onPress={() => setShowDeviceSwitcher(true)}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text style={{ fontSize: 18, marginRight: 8 }}>🏠</Text>
                    <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 15 }}>
                      {devices.find(d => d.mac === selectedMac)?.name || devices[0]?.name || 'Wybierz centralkę'}
                    </Text>
                  </View>
                  <Text style={{ color: '#64b5f6', fontSize: 13, fontWeight: 'bold' }}>Zmień ›</Text>
                </TouchableOpacity>
              )}

              {/* ── TAMPER ALERT BANNER ── shown whenever the second-board enclosure is open */}
              {lockState.tamper && (
                <View style={styles.tamperBanner}>
                  <Text style={styles.tamperBannerTitle}>⚠️  ALARM SABOTAŻOWY</Text>
                  <Text style={styles.tamperBannerBody}>
                    Obudowa panelu RFID jest otwarta lub zdjęta.{'\n'}
                    Zdalnie otwieranie zamka zostało zablokowane.{'\n'}
                    Sprawdź panel natychmiast.
                  </Text>
                </View>
              )}
              {isLocalMode && (
                <View style={{ backgroundColor: '#1c1917', borderWidth: 1, borderColor: '#444', borderRadius: 10, padding: 10, marginBottom: 14 }}>
                  <Text style={{ color: '#aaa', fontSize: 12, textAlign: 'center', fontWeight: 'bold' }}>🔌 TRYB LOKALNY - bez internetu, bez konta w chmurze</Text>
                </View>
              )}
              {errorMessage ? <View style={styles.errorCard}><Text style={styles.errorTextInsideCard}>⚠️ {errorMessage}</Text></View> : null}
              <View style={styles.statusBox}>
                <Text style={styles.label}>Stan Zamka:</Text>

                {/*Dynamiczne kolory dla 3 stanów automatyki */}
                <Text style={[styles.valueBold, {
                  color:
                  lockState.lock === true ? '#81c784' :
                  lockState.lock === 'pending' ? '#ffb74d' :
                  lockState.lock === 'offline' ? '#777' : '#e57373'
                }]}>
                {lockState.lock === true && '🔓 OTWARTY / SYSTEM ZWOLNIONY'}
                {lockState.lock === 'pending' && '⚡ WYWOŁYWANIE SYGNAŁU...'}
                {lockState.lock === 'offline' && '❌ CENTRALKA OFFLINE'}
                {lockState.lock === false && '🔒 ZABEZPIECZONY / RYGIEL ZABLOKOWANY'}
                </Text>

                <Text style={styles.subLabel}>Bieżący tryb operacyjny:
                  {lockState.lock === 'offline' ? 'Offline' : ` ${lockState.mode || 'Brak danych'}`}</Text>
              </View>

              {/*Dynamiczny przycisk */}
              <TouchableOpacity
                style={[styles.actionTriggerBtn, {
                  backgroundColor: lockState.lock === true ? '#cc3333' : lockState.lock === 'pending' ? '#ffa726' : '#2e7d32'
                }]}
                disabled={lockState.lock === 'pending'}
                onPress={() => executeCommand('/api/unlock')}>
                <Text style={styles.btnText}>
                  {lockState.lock === true ? 'Zwalnianie zamka...' : lockState.lock === 'pending' ? 'Oczekiwanie na zamek...' : 'Otwórz Drzwi Zdalnie'}
                </Text>
              </TouchableOpacity>
            </ScrollView>
          )}

        {currentScreen === 'directory' && (
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ flex: 1 }}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 100}
          >
          <ScrollView contentContainerStyle={styles.scrollWrapper} keyboardShouldPersistTaps="handled">
    <Text style={styles.screenHeaderText}>👥 Lista Użytkowników</Text>

    {/* 🌟 SEKCJA PAROWANIA PRZENIESIONA TUTAJ */}
    {/* Limit kart z pakietu jest widoczny ZAWCZASU: przy komplecie kart moduł jest
        wyszarzony i tłumaczy powód, zamiast pozwolić kliknąć i zwrócić błąd 403.
        Usunięcie karty automatycznie odblokowuje dodawanie. */}
    {(() => {
      const maxCards = lockState.entitlements?.maxCards;
      const cardsFull = !isLocalMode && maxCards != null && lockState.total >= maxCards;
      const isLearning = lockState.mode === 'Uczenie';
      return (
    <View style={[styles.card, cardsFull && !isLearning ? { opacity: 0.55 } : null]}>
      <Text style={styles.sectionHeader}>Dodawanie nowej karty</Text>

      {cardsFull && !isLearning && (
        <View style={{ backgroundColor: '#2a1a1a', borderRadius: 8, borderWidth: 1, borderColor: '#5c2b2b', padding: 12, marginBottom: 12 }}>
          <Text style={{ color: '#ffb300', fontWeight: 'bold', fontSize: 13, marginBottom: 4 }}>
            Limit kart wyczerpany ({lockState.total}/{maxCards})
          </Text>
          <Text style={{ color: '#aaa', fontSize: 12, lineHeight: 17 }}>
            Twój pakiet {lockState.entitlements?.tier === 'free' ? 'darmowy' : lockState.entitlements?.tier} obejmuje {maxCards} {maxCards === 1 ? 'kartę' : 'karty'}.
            Usuń jedną z listy poniżej, aby dodać inną — albo zwiększ pakiet.
          </Text>
          <TouchableOpacity style={{ marginTop: 10 }} onPress={() => { navigateTo('pakiet'); loadLicense(); }}>
            <Text style={{ color: '#64b5f6', fontWeight: 'bold', fontSize: 12 }}>💳 Zobacz pakiety ›</Text>
          </TouchableOpacity>
        </View>
      )}

      {isLearning ? (
        <Text style={styles.learningAlertText}>⚠️ Urządzenie oczekuje na zbliżenie fizycznego klucza RFID do czytnika...</Text>
      ) : (
        <TextInput
          style={[styles.inputField, cardsFull ? { color: '#666' } : null]}
          placeholder="Nazwa nowego profilu (np. Jan Kowalski)"
          placeholderTextColor="#555"
          editable={!cardsFull}
          value={newName}
          onChangeText={setNewName}
        />
      )}
      <TouchableOpacity
        style={[styles.secondaryBtn, isLearning ? { backgroundColor: '#cc3333' } : { backgroundColor: cardsFull ? '#242424' : '#333' }]}
        onPress={handleToggleLearn}
        disabled={cardsFull && !isLearning}
      >
        <Text style={[styles.btnText, cardsFull && !isLearning ? { color: '#777' } : null]}>
          {isLearning ? '🛑 Wyłącz Wykrywanie Czytnika' : (cardsFull ? '🔒 Limit kart osiągnięty' : 'Uruchom Tryb Uczenia')}
        </Text>
      </TouchableOpacity>
    </View>
      );
    })()}

    {/* LISTA UŻYTKOWNIKÓW */}
    <View style={styles.card}>
      {/* Licznik pokazuje limit z PAKIETU (nie zaszyte „/10" z czasów EEPROM-u —
          urządzenie mieści 200 kart, a realnie wiąże licencja). */}
      <Text style={styles.sectionHeader}>
        Zarejestrowane Karty ({lockState.total}{lockState.entitlements?.maxCards != null ? `/${lockState.entitlements.maxCards}` : ''})
      </Text>
              {/* Klucz i mutacje po STABILNYM user.id (nie po slocie sprzętowym!).
                  Wcześniej key={user.idx} powodował duplikaty kluczy React (dwa edytory
                  naraz) i mutacje trafiające w niewłaściwą kartę. Fallback na idx dla
                  zgodności ze starszym serwerem, który nie zwracał jeszcze `id`. */}
              {lockState.users.map((user, position) => {
                const cardKey = user.id != null ? user.id : `slot-${user.idx}-${position}`;
                const mutationRef = user.id != null ? { id: user.id } : { idx: user.idx };
                return (
                <View key={cardKey} style={{ backgroundColor: '#1a1a2e', borderRadius: 8, padding: 10, marginBottom: 8 }}>
                  {cardRenameIdx === cardKey ? (
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <TextInput style={[styles.inputField, { flex: 1, marginBottom: 0 }]}
                        value={cardRenameName} onChangeText={setCardRenameName}
                        placeholder="Nowa nazwa" placeholderTextColor="#555" autoFocus />
                      <TouchableOpacity style={[styles.secondaryBtn, { paddingHorizontal: 12 }]} onPress={cardRename}>
                        <Text style={styles.btnText}>✓</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[styles.secondaryBtn, { paddingHorizontal: 12, backgroundColor: '#333' }]} onPress={() => { setCardRenameIdx(null); setCardRenameRef(null); }}>
                        <Text style={styles.btnText}>✕</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: user.active ? '#fff' : '#666', fontSize: 15 }}>{user.name}</Text>
                        {user.schedule_enabled && (
                          <Text style={{ color: '#64b5f6', fontSize: 10, marginTop: 2 }}>📅 Harmonogram</Text>
                        )}
                      </View>
                      <TouchableOpacity onPress={() => { setCardRenameIdx(cardKey); setCardRenameRef(mutationRef); setCardRenameName(user.name); }} style={{ paddingHorizontal: 8 }}>
                        <Text style={{ color: '#64b5f6', fontSize: 12 }}>Zmień</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => openScheduleEditor(user, 'card')} style={{ paddingHorizontal: 8 }}>
                        <Text style={{ color: user.schedule_enabled ? '#ffb300' : '#64b5f6', fontSize: 12 }}>📅</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => executeCommand('/api/user/toggle_active', mutationRef)} style={{ paddingHorizontal: 8 }}>
                        <Text style={{ color: user.active ? '#81c784' : '#ffb300', fontWeight: 'bold', fontSize: 12 }}>{user.active ? 'Aktywny' : 'Zamrożony'}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => executeCommand('/api/user/delete', mutationRef)} style={{ paddingHorizontal: 8 }}>
                        <Text style={{ color: '#e57373', fontWeight: 'bold', fontSize: 12 }}>❌</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
                );
              })}
              {lockState.users.length === 0 ? <Text style={styles.subLabel}>Brak rekordów przypisanych do tego zamka.</Text> : null}
            </View>

            {/* ── Kody PIN Klawiatury ─────────────────────────────────────── */}
            {!isLocalMode && (
              <View style={styles.card}>
                <Text style={styles.sectionHeader}>🔢 Kody PIN Klawiatury</Text>
                <Text style={{ color: '#aaa', fontSize: 12, marginBottom: 12 }}>
                  Każda osoba ma własny PIN (4–8 cyfr). Wpisz na klawiaturze i zatwierdź{' '}
                  <Text style={{ color: '#64b5f6' }}>#</Text>. Gwiazdka{' '}
                  <Text style={{ color: '#64b5f6' }}>*</Text> czyści bufor.
                </Text>
                {keypadPins.map((kp) => (
                  <View key={kp.id} style={{ backgroundColor: '#1a1a2e', borderRadius: 8, padding: 10, marginBottom: 8 }}>
                    {kpRenameId === kp.id ? (
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <TextInput style={[styles.inputField, { flex: 1, marginBottom: 0 }]}
                          value={kpRenameName} onChangeText={setKpRenameName}
                          placeholder="Nowa nazwa" placeholderTextColor="#555" autoFocus />
                        <TouchableOpacity style={[styles.secondaryBtn, { paddingHorizontal: 12 }]} onPress={kpRename}>
                          <Text style={styles.btnText}>✓</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={[styles.secondaryBtn, { paddingHorizontal: 12, backgroundColor: '#333' }]} onPress={() => setKpRenameId(null)}>
                          <Text style={styles.btnText}>✕</Text>
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: kp.active ? '#81c784' : '#555', marginRight: 10 }} />
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: kp.active ? '#fff' : '#666', fontSize: 15 }}>{kp.name}</Text>
                          {(kp.is_guest_code || kp.expires_at || kp.schedule_enabled) && (
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 2 }}>
                              {kp.is_guest_code && (
                                <Text style={{ color: '#ffb300', fontSize: 10, marginRight: 8 }}>👤 Gość</Text>
                              )}
                              {kp.expires_at && (
                                <Text style={{ color: new Date(kp.expires_at) < new Date() ? '#ef4444' : '#aaa', fontSize: 10, marginRight: 8 }}>
                                  ⏱ {new Date(kp.expires_at) < new Date() ? 'Wygasł' : `do ${new Date(kp.expires_at).toLocaleDateString('pl-PL')}`}
                                </Text>
                              )}
                              {kp.max_uses !== null && kp.max_uses !== undefined && (
                                <Text style={{ color: '#aaa', fontSize: 10, marginRight: 8 }}>🔁 {kp.use_count || 0}/{kp.max_uses}</Text>
                              )}
                              {kp.schedule_enabled && (
                                <Text style={{ color: '#64b5f6', fontSize: 10 }}>📅 Harmonogram</Text>
                              )}
                            </View>
                          )}
                        </View>
                        <TouchableOpacity onPress={() => { setKpRenameId(kp.id); setKpRenameName(kp.name); }} style={{ paddingHorizontal: 8 }}>
                          <Text style={{ color: '#64b5f6', fontSize: 12 }}>Zmień</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => openScheduleEditor(kp, 'pin')} style={{ paddingHorizontal: 8 }}>
                          <Text style={{ color: kp.schedule_enabled ? '#ffb300' : '#64b5f6', fontSize: 12 }}>📅</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => kpToggle(kp.id)} style={{ paddingHorizontal: 8 }}>
                          <Text style={{ color: '#64b5f6', fontSize: 12 }}>{kp.active ? 'Blok.' : 'Aktyw.'}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => kpDelete(kp.id, kp.name)} style={{ paddingHorizontal: 8 }}>
                          <Text style={{ color: '#ef4444', fontSize: 12 }}>Usuń</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                ))}
                {keypadPins.length === 0 && (
                  <Text style={{ color: '#555', fontSize: 12, textAlign: 'center', marginBottom: 12 }}>Brak skonfigurowanych PINów</Text>
                )}
                {/* Limit PIN-ów bierzemy z PAKIETU (dawniej zaszyte 20). Przy komplecie
                    pokazujemy powód zamiast chować formularz bez wyjaśnienia. */}
                {(() => {
                  const maxPins = lockState.entitlements?.maxPins;
                  const pinsFull = !isLocalMode && maxPins != null && keypadPins.length >= maxPins;
                  if (!pinsFull) return null;
                  return (
                    <View style={{ backgroundColor: '#2a1a1a', borderRadius: 8, borderWidth: 1, borderColor: '#5c2b2b', padding: 12, marginTop: 8 }}>
                      <Text style={{ color: '#ffb300', fontWeight: 'bold', fontSize: 13, marginBottom: 4 }}>
                        Limit PIN-ów wyczerpany ({keypadPins.length}/{maxPins})
                      </Text>
                      <Text style={{ color: '#aaa', fontSize: 12, lineHeight: 17 }}>
                        Usuń istniejący PIN, aby dodać nowy — albo zwiększ pakiet.
                      </Text>
                      <TouchableOpacity style={{ marginTop: 10 }} onPress={() => { navigateTo('pakiet'); loadLicense(); }}>
                        <Text style={{ color: '#64b5f6', fontWeight: 'bold', fontSize: 12 }}>💳 Zobacz pakiety ›</Text>
                      </TouchableOpacity>
                    </View>
                  );
                })()}

                {(isLocalMode || lockState.entitlements?.maxPins == null || keypadPins.length < lockState.entitlements.maxPins) && (
                  <>
                    {/* Kody gościnne to funkcja PŁATNA (Silver+). Na pakiecie darmowym
                        zakładka jest wyszarzona i od razu tłumaczy dlaczego — klient nie
                        dowiaduje się o tym dopiero po wypełnieniu formularza. */}
                    {(() => {
                      const guestAllowed = isLocalMode || lockState.entitlements?.guestCodes !== false;
                      return (
                    <>
                    <View style={{ flexDirection: 'row', marginTop: 8, marginBottom: guestAllowed ? 12 : 6, backgroundColor: '#0f0f11', borderRadius: 8, padding: 4 }}>
                      <TouchableOpacity
                        style={{ flex: 1, paddingVertical: 8, borderRadius: 6, backgroundColor: kpMode === 'normal' ? '#1a3a5c' : 'transparent', alignItems: 'center' }}
                        onPress={() => setKpMode('normal')}
                      >
                        <Text style={{ color: kpMode === 'normal' ? '#fff' : '#666', fontWeight: 'bold', fontSize: 13 }}>Stały PIN</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={{ flex: 1, paddingVertical: 8, borderRadius: 6, backgroundColor: (guestAllowed && kpMode === 'guest') ? '#5c33cf' : 'transparent', alignItems: 'center', opacity: guestAllowed ? 1 : 0.45 }}
                        onPress={() => guestAllowed && setKpMode('guest')}
                        disabled={!guestAllowed}
                      >
                        <Text style={{ color: guestAllowed ? (kpMode === 'guest' ? '#fff' : '#666') : '#555', fontWeight: 'bold', fontSize: 13 }}>
                          {guestAllowed ? '👤 Kod gościnny' : '🔒 Kod gościnny'}
                        </Text>
                      </TouchableOpacity>
                    </View>

                    {!guestAllowed && (
                      <TouchableOpacity
                        style={{ backgroundColor: '#161622', borderRadius: 8, borderWidth: 1, borderColor: '#2a2a3e', padding: 10, marginBottom: 12 }}
                        onPress={() => { navigateTo('pakiet'); loadLicense(); }}
                      >
                        <Text style={{ color: '#aaa', fontSize: 12, lineHeight: 17 }}>
                          🔒 <Text style={{ fontWeight: 'bold', color: '#ccc' }}>Kody gościnne</Text> (PIN z datą ważności i limitem użyć) są dostępne od pakietu <Text style={{ fontWeight: 'bold', color: '#ccc' }}>Silver</Text>.
                        </Text>
                        <Text style={{ color: '#64b5f6', fontWeight: 'bold', fontSize: 12, marginTop: 6 }}>💳 Zobacz pakiety ›</Text>
                      </TouchableOpacity>
                    )}
                    </>
                      );
                    })()}

                    <Text style={styles.inputLabelText}>Nazwa osoby</Text>
                    <TextInput style={styles.inputField} placeholder="np. Mama, Tata, Gość"
                      placeholderTextColor="#555" value={kpNewName} onChangeText={setKpNewName} />
                    <Text style={styles.inputLabelText}>PIN (4–8 cyfr)</Text>
                    <TextInput style={styles.inputField} placeholder="••••" placeholderTextColor="#555"
                      keyboardType="numeric" secureTextEntry maxLength={8}
                      value={kpNewCode} onChangeText={setKpNewCode} />
                    <Text style={styles.inputLabelText}>Potwierdź PIN</Text>
                    <TextInput style={styles.inputField} placeholder="••••" placeholderTextColor="#555"
                      keyboardType="numeric" secureTextEntry maxLength={8}
                      value={kpNewConfirm} onChangeText={setKpNewConfirm} />

                    {kpMode === 'guest' && (isLocalMode || lockState.entitlements?.guestCodes !== false) && (
                      <>
                        <Text style={styles.inputLabelText}>Ważny przez (dni)</Text>
                        <TextInput style={styles.inputField} placeholder="np. 3"
                          placeholderTextColor="#555" keyboardType="number-pad"
                          value={kpGuestExpiryDays} onChangeText={setKpGuestExpiryDays} />
                        <Text style={styles.inputLabelText}>Limit użyć (opcjonalnie)</Text>
                        <TextInput style={styles.inputField} placeholder="puste = bez limitu"
                          placeholderTextColor="#555" keyboardType="number-pad"
                          value={kpGuestMaxUses} onChangeText={setKpGuestMaxUses} />
                      </>
                    )}

                    {kpStatus ? (
                      <Text style={{ color: kpStatus.startsWith('✓') ? '#81c784' : '#ef4444', fontSize: 12, marginBottom: 8 }}>{kpStatus}</Text>
                    ) : null}
                    {(() => {
                      // Gdy pakiet spadł do darmowego, a w stanie został wybrany tryb gościnny —
                      // traktujemy to jak zwykły PIN, żeby przycisk nie obiecywał niedostępnej funkcji.
                      const guestActive = kpMode === 'guest' && (isLocalMode || lockState.entitlements?.guestCodes !== false);
                      return (
                        <TouchableOpacity style={[styles.secondaryBtn, { backgroundColor: guestActive ? '#5c33cf' : '#1a3a5c', width: '100%' }]} onPress={kpAdd}>
                          <Text style={styles.btnText}>{guestActive ? '👤 Utwórz kod gościnny' : '➕ Dodaj PIN'}</Text>
                        </TouchableOpacity>
                      );
                    })()}
                  </>
                )}
              </View>
            )}
          </ScrollView>
          </KeyboardAvoidingView>
        )}

        {currentScreen === 'system' && (
          <ScrollView contentContainerStyle={styles.scrollWrapper}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <Text style={styles.screenHeaderText}>📋 {isLogSearchMode ? 'Wyszukiwanie w logach' : 'Dziennik Zdarzeń (Real-Time)'}</Text>
              <TouchableOpacity onPress={() => { setIsLogSearchMode(!isLogSearchMode); if (!isLogSearchMode) runLogSearch(); }}>
                <Text style={{ color: '#64b5f6', fontSize: 13, fontWeight: 'bold' }}>{isLogSearchMode ? '⏱ Na żywo' : '🔍 Szukaj'}</Text>
              </TouchableOpacity>
            </View>

            {!isLogSearchMode && (
              <View style={styles.card}>
                <ScrollView nestedScrollEnabled style={styles.internalLogBox}>{lockState.logs.map((log, index) => <Text key={index} style={styles.logText}>{log}</Text>)}</ScrollView>
              </View>
            )}

            {isLogSearchMode && (
              <>
                <View style={styles.card}>
                  <TextInput style={styles.inputField} placeholder="Szukaj w treści (np. imię, słowo kluczowe)..."
                    placeholderTextColor="#555" value={logSearchQuery} onChangeText={setLogSearchQuery}
                    onSubmitEditing={() => runLogSearch()} />

                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 12 }}>
                    {LOG_CATEGORIES.map((cat) => (
                      <TouchableOpacity
                        key={cat.key}
                        onPress={() => setLogSearchCategory(cat.key)}
                        style={{
                          paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, marginRight: 8, marginBottom: 8,
                          backgroundColor: logSearchCategory === cat.key ? cat.color : '#0f0f11',
                          borderWidth: 1, borderColor: logSearchCategory === cat.key ? cat.color : '#333',
                        }}
                      >
                        <Text style={{ color: logSearchCategory === cat.key ? '#000' : '#aaa', fontSize: 12, fontWeight: 'bold' }}>{cat.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.inputLabelText}>Od (RRRR-MM-DD)</Text>
                      <TextInput style={styles.inputField} placeholder="2026-01-01" placeholderTextColor="#555"
                        value={logSearchFrom} onChangeText={setLogSearchFrom} maxLength={10} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.inputLabelText}>Do (RRRR-MM-DD)</Text>
                      <TextInput style={styles.inputField} placeholder="2026-12-31" placeholderTextColor="#555"
                        value={logSearchTo} onChangeText={setLogSearchTo} maxLength={10} />
                    </View>
                  </View>

                  <TouchableOpacity style={[styles.secondaryBtn, { backgroundColor: '#5c33cf', width: '100%', marginTop: 4 }]} onPress={() => runLogSearch()}>
                    <Text style={styles.btnText}>{logSearchLoading ? 'Szukam...' : `🔍 Szukaj${logSearchTotal ? ` (${logSearchTotal} wyników)` : ''}`}</Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.card}>
                  {logSearchResults.length === 0 && !logSearchLoading ? (
                    <Text style={{ color: '#666', fontSize: 13, textAlign: 'center', paddingVertical: 20 }}>
                      Brak wyników — dostosuj filtry i spróbuj ponownie.
                    </Text>
                  ) : (
                    logSearchResults.map((log, idx) => {
                      const catInfo = LOG_CATEGORIES.find(c => c.key === log.category) || { color: '#666', label: log.category };
                      const timeStr = new Date(log.time).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                      return (
                        <View key={idx} style={{ paddingVertical: 8, borderBottomWidth: idx < logSearchResults.length - 1 ? 1 : 0, borderBottomColor: '#222' }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 2 }}>
                            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: catInfo.color, marginRight: 6 }} />
                            <Text style={{ color: '#888', fontSize: 11 }}>{timeStr}</Text>
                          </View>
                          <Text style={{ color: '#fff', fontSize: 13 }}>{log.message}</Text>
                        </View>
                      );
                    })
                  )}
                  {logSearchResults.length > 0 && logSearchResults.length < logSearchTotal && (
                    <TouchableOpacity style={[styles.secondaryBtn, { marginTop: 12, backgroundColor: '#333' }]} onPress={() => runLogSearch(true)}>
                      <Text style={styles.btnText}>{logSearchLoading ? 'Ładowanie...' : `Załaduj więcej (${logSearchResults.length}/${logSearchTotal})`}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </>
            )}
          </ScrollView>
        )}

        {/* EKRAN AKTUALIZACJI OTA (Z INTEGRACJĄ NOWYCH STATUSÓW) */}
        {currentScreen === 'ota' && (
          <ScrollView contentContainerStyle={styles.scrollWrapper}>
            <Text style={styles.screenHeaderText}>💾 Aktualizacja Firmware</Text>

            <View style={styles.statusBox}>
              <Text style={styles.label}>Bieżąca wersja oprogramowania:</Text>
              <Text style={[styles.valueBold, { color: '#64b5f6' }]}>{lockState.version}</Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionHeader}>Weryfikacja dostępności aktualizacji</Text>

              {otaState === 'idle' && (
                <TouchableOpacity style={[styles.actionTriggerBtn, { backgroundColor: '#3b82f6' }]} onPress={handleCheckUpdate}>
                  <Text style={styles.btnText}>🔍 Sprawdź dostępność aktualizacji</Text>
                </TouchableOpacity>
              )}

              {otaState === 'checking' && (
                <View style={[styles.actionTriggerBtn, { backgroundColor: '#4b5563', flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }]}>
                  <LoadingPulse size={22} color="#fff" />
                  <Text style={[styles.btnText, { marginLeft: 10 }]}>Sprawdzanie dostępności aktualizacji...</Text>
                </View>
              )}

              {otaState === 'up-to-date' && (
                <TouchableOpacity style={[styles.actionTriggerBtn, { backgroundColor: '#10b981' }]} onPress={handleCheckUpdate}>
                  <Text style={styles.btnText}>✅ Jesteś na najnowszej wersji</Text>
                </TouchableOpacity>
              )}

              {otaState === 'available' && (
                <View style={{ marginTop: 8 }}>
                  <Text style={[styles.learningAlertText, { marginBottom: 16 }]}>🚀 Dostępna jest nowsza wersja oprogramowania</Text>
                  <TouchableOpacity style={[styles.actionTriggerBtn, { backgroundColor: '#e11d48', marginTop: 0 }]} onPress={handleExecuteUpdate}>
                    <Text style={styles.btnText}>Zaktualizuj oprogramowanie</Text>
                  </TouchableOpacity>
                </View>
              )}

              {otaState === 'downloading_server' && (
                <TouchableOpacity style={[styles.actionTriggerBtn, { backgroundColor: '#f59e0b' }]} disabled>
                  <Text style={styles.btnText}>📥 Pobieranie aktualizacji na serwer...</Text>
                </TouchableOpacity>
              )}

              {otaState === 'flashing_device' && (
                <View style={{ marginTop: 8 }}>
                  <TouchableOpacity style={[styles.actionTriggerBtn, { backgroundColor: '#2563eb', marginTop: 0 }]} disabled>
                    <Text style={styles.btnText}>⚡ Pobieranie: {lockState.otaProgress || 0}%</Text>
                  </TouchableOpacity>

                  {/* TŁO PASKA POSTĘPU */}
                  <View style={{ width: '100%', height: 8, backgroundColor: '#222', borderRadius: 4, overflow: 'hidden', marginTop: 4 }}>
                    {/* DYNAMICZNY PASEK WYPEŁNIENIA */}
                    <View style={{ width: `${lockState.otaProgress || 0}%`, height: '100%', backgroundColor: '#64b5f6' }} />
                  </View>

                  <Text style={[styles.subLabel, { marginTop: 12, textAlign: 'center', color: '#aaa' }]}>
                    Trwa strumieniowanie oprogramowania układowego z serwera Proxmox do pamięci Flash centralki przez sieć lokalną.
                  </Text>
                </View>
              )}

              {otaState === 'success' && (
                <TouchableOpacity style={[styles.actionTriggerBtn, { backgroundColor: '#059669' }]} disabled>
                  <Text style={styles.btnText}>🎉 Zaktualizowano pomyślnie!</Text>
                </TouchableOpacity>
              )}
            </View>
          </ScrollView>
        )}

        {/* POWIADOMIENIA PUSH */}

        {currentScreen === 'notifications' && (
          <ScrollView contentContainerStyle={styles.scrollWrapper}>
            <Text style={styles.screenHeaderText}>🔔 Preferencje Powiadomień</Text>

            <View style={styles.card}>
              <Text style={styles.sectionHeader}>Zarządzanie Alertami Push</Text>

              {/* PRZEŁĄCZNIK 1: WEJŚCIA LOKATORÓW */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginVertical: 10 }}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={{ color: '#fff', fontSize: 15, fontWeight: 'bold' }}>Powiadomienia o wejściach</Text>
                  <Text style={{ color: '#666', fontSize: 12, marginTop: 2 }}>Wyślij alert, gdy lokator (np. Tomasz 2) pomyślnie otworzy drzwi kartą RFID.</Text>
                </View>
                <Switch
                  trackColor={{ false: '#202024', true: '#5c33cf' }}
                  thumbColor={pushEntries ? '#64b5f6' : '#f4f3f4'}
                  value={pushEntries}
                  onValueChange={(val) => {
                    setPushEntries(val);
                    savePushPreferences(val, pushAlarms);
                  }}
                />
              </View>

              <View style={{ width: '100%', height: 1, backgroundColor: '#222', marginVertical: 14 }} />

              {/* PRZEŁĄCZNIK 2: ALERTY BEZPIECZEŃSTWA */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginVertical: 10 }}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={{ color: '#fff', fontSize: 15, fontWeight: 'bold' }}>Alerty bezpieczeństwa</Text>
                  <Text style={{ color: '#666', fontSize: 12, marginTop: 2 }}>Natychmiastowy alarm w telefonie w przypadku wykrycia prób ataków BruteForce.</Text>
                </View>
                <Switch
                  trackColor={{ false: '#202024', true: '#5c33cf' }}
                  thumbColor={pushAlarms ? '#64b5f6' : '#f4f3f4'}
                  value={pushAlarms}
                  onValueChange={(val) => {
                    setPushAlarms(val);
                    savePushPreferences(pushEntries, val);
                  }}
                />
              </View>
            </View>
          </ScrollView>
        )}

        {currentScreen === 'settings' && (
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ flex: 1 }}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 100}
          >
            <ScrollView contentContainerStyle={styles.scrollWrapper} keyboardShouldPersistTaps="handled">
              <Text style={styles.screenHeaderText}>⚙️ Konfiguracja Infrastruktury</Text>

              {!isLocalMode && (
                <View style={styles.card}>
                  <Text style={styles.sectionHeader}>👤 Dane Profilu</Text>
                  <Text style={[styles.inputLabelText, {color: '#81c784', fontSize: 15, fontWeight:'600'}]}>✓ {lockState.account ? lockState.account.email : email}</Text>
                </View>
              )}

              {/* FORMULARZ: ZMIANA HASŁA APLIKACJI (niedostępne w Trybie Lokalnym - brak konta) */}
              {!isLocalMode && (
                <View style={styles.card}>
                  <Text style={styles.sectionHeader}>🔐 Zmiana Hasła do Konta Aplikacji</Text>
                  <Text style={styles.inputLabelText}>Nowe Hasło Logowania:</Text>
                  <View style={{ width: '100%', position: 'relative' }}>
                    <TextInput
                      style={styles.inputField}
                      secureTextEntry={secureSettingsApp}
                      placeholder="Wprowadź nowe hasło do aplikacji"
                      placeholderTextColor="#555"
                      value={settingsAppPass}
                      onChangeText={setSettingsAppPass}
                    />
                    <TouchableOpacity style={{ position: 'absolute', right: 14, top: 16 }} onPress={() => setSecureSettingsApp(!secureSettingsApp)}>
                      <Text style={{ color: '#64b5f6', fontWeight: 'bold' }}>{secureSettingsApp ? "Pokaż" : "Ukryj"}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* FORMULARZ: ZMIANA HASŁA WI-FI ZAMKA (niedostępne w Trybie Lokalnym) */}
              {isLocalMode ? (
                <View style={styles.card}>
                  <Text style={styles.sectionHeader}>📶 Sieć Wi-Fi Centralki</Text>
                  <Text style={styles.inputLabelText}>
                    Centralka działa w Trybie Lokalnym i nie łączy się z żadną siecią domową - aplikacja rozmawia z nią przez jej własny punkt dostępu CTRLABLE_SETUP. Aby przejść do trybu online z kontem w chmurze, przywróć ustawienia fabryczne centralki i skonfiguruj ją ponownie.
                  </Text>
                </View>
              ) : (
                <View style={styles.card}>
                  <Text style={styles.sectionHeader}>📶 Zmiana Konfiguracji Sieci Wi-Fi Zamka</Text>
                  <Text style={styles.inputLabelText}>Identyfikator Sieci (SSID):</Text>
                  <TextInput style={styles.inputField} placeholder="Nazwa nowej sieci Wi-Fi" placeholderTextColor="#555" value={settingsSsid} onChangeText={setSettingsSsid} />

                  <Text style={styles.inputLabelText}>Hasło do Sieci:</Text>
                  <View style={{ width: '100%', position: 'relative' }}>
                    <TextInput
                      style={styles.inputField}
                      secureTextEntry={secureSettingsWifi}
                      placeholder="Hasło nowej sieci Wi-Fi"
                      placeholderTextColor="#555"
                      value={settingsWifiPass}
                      onChangeText={setSettingsWifiPass}
                    />
                    <TouchableOpacity style={{ position: 'absolute', right: 14, top: 16 }} onPress={() => setSecureSettingsWifi(!secureSettingsWifi)}>
                      <Text style={{ color: '#64b5f6', fontWeight: 'bold' }}>{secureSettingsWifi ? "Pokaż" : "Ukryj"}</Text>
                    </TouchableOpacity>
                  </View>

                  <TouchableOpacity style={[styles.secondaryBtn, { backgroundColor: '#5c33cf', width: '100%', marginTop: 12 }]} onPress={handleSaveSystemSettings}>
                    <Text style={styles.btnText}>💾 Zapisz Ustawienia i Zrestartuj Zamek</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* STREFA ZAAWANSOWANA: trwałe odłączenie centralki (tylko właściciel) */}
              {!isLocalMode && (devices.find(d => d.mac === selectedMac)?.isOwner) && (
                <View style={[styles.card, { borderColor: '#5c1a1a', borderWidth: 1 }]}>
                  <Text style={[styles.sectionHeader, { color: '#e57373' }]}>⚠️ Strefa zaawansowana</Text>
                  <Text style={styles.inputLabelText}>
                    Trwałe odłączenie tej centralki od konta. Urządzenie wyczyści swoją konfigurację (WiFi, konto, karty RFID) i wróci do trybu konfiguracji CTRLABLE_SETUP. Aby użyć jej ponownie, trzeba ją skonfigurować od nowa. Operacja wymaga potwierdzenia kodem wysłanym na Twój e-mail.
                  </Text>
                  <TouchableOpacity style={[styles.secondaryBtn, { backgroundColor: '#7f1d1d', width: '100%', marginTop: 12 }]} onPress={startDeregister}>
                    <Text style={styles.btnText}>🔌 Odłącz i zresetuj centralkę</Text>
                  </TouchableOpacity>
                </View>
              )}

            </ScrollView>
          </KeyboardAvoidingView>
        )}

        {/* ── EKRAN: CENTRALKI — jedno miejsce na wszystko, co dotyczy urządzeń:
            dodawanie, nazwy, czas otwarcia, administratorzy. Dashboard służy już tylko
            do otwierania i przełączania się między centralkami. ── */}
        {currentScreen === 'devices' && (
          <ScrollView contentContainerStyle={styles.scrollWrapper}>
            <Text style={styles.screenHeaderText}>🏠 Centralki</Text>

            {/* Liczba centralek NIE jest limitowana pakietem (decyzja produktowa) —
                pakiet ogranicza pojemność każdej z nich: karty, PIN-y, administratorów. */}
            <TouchableOpacity
              style={[styles.secondaryBtn, { backgroundColor: '#2e7d32', marginBottom: 8 }]}
              onPress={() => {
                setInitMode('online');
                setDetectedDevice(false);
                setAuthStep('connect');
                setIsConfigured(false);
              }}
            >
              <Text style={styles.btnText}>➕ Dodaj nową centralkę</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.secondaryBtn, { backgroundColor: '#1a3a5c', marginBottom: 18 }]} onPress={handleAcceptInvite}>
              <Text style={styles.btnText}>🔑 Mam kod zaproszenia</Text>
            </TouchableOpacity>

            {devices.length === 0 && (
              <Text style={styles.subLabel}>Nie masz jeszcze żadnej centralki. Dodaj pierwszą powyżej.</Text>
            )}

            {devices.map((d) => {
              const activeSeconds = (autoLockSeconds && autoLockSeconds[d.mac]) ?? d.autoLockSeconds ?? 3;
              return (
                <View key={d.mac} style={[styles.card, d.mac === selectedMac ? { borderColor: '#5c33cf', borderWidth: 1 } : null]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 16 }}>{d.name}</Text>
                      <Text style={{ color: d.online ? '#81c784' : '#e57373', fontSize: 12, marginTop: 3 }}>
                        {d.online ? '● Online' : '● Offline'} · {d.mode || '—'}{!d.isOwner ? ' · Udostępnione Ci' : ''}
                      </Text>
                      <Text style={{ color: '#555', fontSize: 11, marginTop: 2 }}>{d.mac}{d.firmwareVersion ? ` · ${d.firmwareVersion}` : ''}</Text>
                    </View>
                    {d.mac === selectedMac
                      ? <Text style={{ color: '#5c33cf', fontWeight: 'bold', fontSize: 12 }}>AKTYWNA</Text>
                      : (
                        <TouchableOpacity onPress={() => setSelectedMac(d.mac)} style={{ paddingHorizontal: 10, paddingVertical: 6 }}>
                          <Text style={{ color: '#64b5f6', fontSize: 12, fontWeight: 'bold' }}>Wybierz</Text>
                        </TouchableOpacity>
                      )}
                  </View>

                  {d.isOwner && (
                    <>
                      <View style={{ height: 1, backgroundColor: '#222', marginVertical: 12 }} />

                      <Text style={{ color: '#aaa', fontSize: 12, fontWeight: 'bold', marginBottom: 8 }}>⏱️ Czas otwarcia rygla</Text>
                      <Text style={[styles.subLabel, { marginBottom: 10, fontSize: 11 }]}>
                        Jak długo rygiel pozostaje otwarty po karcie, PIN-ie lub otwarciu z aplikacji.
                      </Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                        {[3, 5, 10, 15, 30].map((sec) => (
                          <TouchableOpacity
                            key={sec}
                            style={{
                              paddingVertical: 9, paddingHorizontal: 15, borderRadius: 8,
                              backgroundColor: activeSeconds === sec ? '#5c33cf' : '#1a1a2e',
                              borderWidth: 1, borderColor: activeSeconds === sec ? '#7c5cff' : '#2a2a3e',
                            }}
                            onPress={() => saveAutoLockSeconds(d.mac, sec)}
                          >
                            <Text style={{ color: activeSeconds === sec ? '#fff' : '#aaa', fontWeight: 'bold', fontSize: 13 }}>{sec}s</Text>
                          </TouchableOpacity>
                        ))}
                      </View>

                      <View style={{ flexDirection: 'row', marginTop: 14, gap: 8 }}>
                        <TouchableOpacity style={[styles.secondaryBtn, { flex: 1, paddingVertical: 9 }]} onPress={() => handleRenameDevice(d.mac, d.name)}>
                          <Text style={{ color: '#fff', fontSize: 12, fontWeight: 'bold' }}>✏️ Zmień nazwę</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.secondaryBtn, { flex: 1, paddingVertical: 9, backgroundColor: '#1a3a5c' }]}
                          onPress={() => { setSelectedMac(d.mac); navigateTo('team'); loadTeam(); }}
                        >
                          <Text style={{ color: '#fff', fontSize: 12, fontWeight: 'bold' }}>👥 Administratorzy</Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
                </View>
              );
            })}
          </ScrollView>
        )}

        {/* ── EKRAN: ZESPÓŁ (współadministratorzy per centralka) — tylko online ── */}
        {currentScreen === 'team' && (
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ flex: 1 }}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 100}
          >
            <ScrollView contentContainerStyle={styles.scrollWrapper} keyboardShouldPersistTaps="handled">
              <Text style={styles.screenHeaderText}>🤝 Zespół — Administratorzy</Text>

              <TouchableOpacity style={[styles.secondaryBtn, { width: '100%', marginBottom: 16, backgroundColor: '#1a3a5c' }]} onPress={handleAcceptInvite}>
                <Text style={styles.btnText}>🔑 Mam kod zaproszenia</Text>
              </TouchableOpacity>

              {teamLoading && (
                <Text style={{ color: '#64b5f6', textAlign: 'center', marginBottom: 12 }}>Wczytywanie…</Text>
              )}

              {(devices || []).filter((d) => d.isOwner).length === 0 ? (
                <View style={styles.card}>
                  <Text style={styles.sectionHeader}>Brak centralek do zarządzania</Text>
                  <Text style={{ color: '#888', fontSize: 13, lineHeight: 19 }}>
                    Administratorami może zarządzać tylko właściciel centralki. Nie jesteś właścicielem żadnego urządzenia — jeśli korzystasz z zaproszenia jako administrator, zarządza nim właściciel, który Cię zaprosił.
                  </Text>
                </View>
              ) : (
                (devices || []).filter((d) => d.isOwner).map((d) => {
                  const admins = teamByMac[d.mac] || [];
                  return (
                    <View key={d.mac} style={styles.card}>
                      <Text style={styles.sectionHeader}>{d.name}</Text>
                      <Text style={{ color: '#666', fontSize: 11, marginTop: -6, marginBottom: 10 }}>{d.mac}</Text>

                      {admins.length === 0 ? (
                        <Text style={{ color: '#888', fontSize: 13, marginBottom: 8 }}>
                          Brak zaproszonych administratorów — na razie tylko Ty (właściciel) zarządzasz tą centralką.
                        </Text>
                      ) : (
                        admins.map((a) => (
                          <View key={a.accountId} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#222' }}>
                            <View style={{ flex: 1, paddingRight: 10 }}>
                              <Text style={{ color: '#fff', fontSize: 14 }}>{a.email}</Text>
                              <Text style={{ color: '#666', fontSize: 11 }}>Administrator · dostęp do tej centralki</Text>
                            </View>
                            <TouchableOpacity onPress={() => revokeFromTeam(d.mac, a.accountId, a.email)}>
                              <Text style={{ color: '#e57373', fontWeight: 'bold', fontSize: 13 }}>Odbierz</Text>
                            </TouchableOpacity>
                          </View>
                        ))
                      )}

                      {/* Limit administratorów z pakietu — max_admins LICZY WŁAŚCICIELA,
                          więc przy limicie 1 nie ma miejsca na żadnego współadmina.
                          Wyszarzamy zawczasu zamiast odsyłać 403 po wysłaniu zaproszenia. */}
                      {(() => {
                        const maxAdmins = lockState.entitlements?.maxAdmins;
                        const usedAdmins = 1 + (teamByMac[d.mac]?.length || 0); // właściciel + współadmini
                        const adminsFull = maxAdmins != null && usedAdmins >= maxAdmins;
                        if (adminsFull) {
                          return (
                            <View style={{ backgroundColor: '#2a1a1a', borderRadius: 8, borderWidth: 1, borderColor: '#5c2b2b', padding: 12, marginTop: 14 }}>
                              <Text style={{ color: '#ffb300', fontWeight: 'bold', fontSize: 13, marginBottom: 4 }}>
                                Limit administratorów wyczerpany ({usedAdmins}/{maxAdmins})
                              </Text>
                              <Text style={{ color: '#aaa', fontSize: 12, lineHeight: 17 }}>
                                {maxAdmins === 1
                                  ? 'Pakiet darmowy obejmuje wyłącznie właściciela centralki. Współadministratorzy są dostępni od pakietu Silver.'
                                  : 'Odbierz dostęp jednemu z administratorów, aby zaprosić kogoś innego — albo zwiększ pakiet.'}
                              </Text>
                              <TouchableOpacity style={{ marginTop: 10 }} onPress={() => { navigateTo('pakiet'); loadLicense(); }}>
                                <Text style={{ color: '#64b5f6', fontWeight: 'bold', fontSize: 12 }}>💳 Zobacz pakiety ›</Text>
                              </TouchableOpacity>
                            </View>
                          );
                        }
                        return (
                          <>
                            <Text style={[styles.inputLabelText, { marginTop: 14 }]}>
                              Zaproś administratora (e-mail):
                              {maxAdmins != null ? <Text style={{ color: '#666', fontWeight: 'normal' }}>  ({usedAdmins}/{maxAdmins})</Text> : null}
                            </Text>
                            <TextInput
                              style={styles.inputField}
                              placeholder="np. jan.kowalski@email.com"
                              placeholderTextColor="#555"
                              autoCapitalize="none"
                              keyboardType="email-address"
                              value={inviteEmails[d.mac] || ''}
                              onChangeText={(t) => setInviteEmails((prev) => ({ ...prev, [d.mac]: t }))}
                            />
                            <TouchableOpacity
                              style={[styles.secondaryBtn, { backgroundColor: '#0284c7', width: '100%', marginTop: 10, opacity: teamBusyMac === d.mac ? 0.5 : 1 }]}
                              disabled={teamBusyMac === d.mac}
                              onPress={() => submitInvite(d.mac)}
                            >
                              <Text style={styles.btnText}>{teamBusyMac === d.mac ? 'Wysyłanie…' : '✉️ Wyślij zaproszenie'}</Text>
                            </TouchableOpacity>
                          </>
                        );
                      })()}
                    </View>
                  );
                })
              )}

              <TouchableOpacity style={[styles.secondaryBtn, { width: '100%', marginTop: 4 }]} onPress={loadTeam}>
                <Text style={styles.btnText}>🔄 Odśwież listę</Text>
              </TouchableOpacity>
            </ScrollView>
          </KeyboardAvoidingView>
        )}

        {currentScreen === 'pakiet' && (
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ flex: 1 }}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 100}
          >
            <ScrollView contentContainerStyle={styles.scrollWrapper} keyboardShouldPersistTaps="handled">
              <Text style={styles.screenHeaderText}>💳 Pakiet i licencja</Text>

              {licenseLoading && (
                <Text style={{ color: '#64b5f6', textAlign: 'center', marginBottom: 12 }}>Wczytywanie…</Text>
              )}

              {license && (
                <>
                  <View style={styles.card}>
                    <Text style={styles.sectionHeader}>Twój pakiet: {tierLabel(license.tier)}</Text>
                    {license.expired && (
                      <Text style={{ color: '#e57373', fontSize: 13, marginBottom: 6, lineHeight: 19 }}>
                        Licencja wygasła — obowiązują limity darmowe. Istniejące karty/PIN-y działają dalej, ale nie dodasz nowych ponad limit.
                      </Text>
                    )}
                    {license.validUntil && (
                      <Text style={{ color: '#888', fontSize: 12, marginBottom: 6 }}>
                        Ważna do: {new Date(license.validUntil).toLocaleDateString('pl-PL')}
                      </Text>
                    )}
                    <Text style={{ color: '#aaa', fontSize: 13, lineHeight: 21 }}>
                      Retencja logów: {license.limits?.logRetentionDays} dni{'\n'}
                      Kody gościnne: {license.limits?.guestCodes ? 'tak' : '—'}{'\n'}
                      Centralki: {license.devicesUsed}{license.limits?.maxDevices != null ? `/${license.limits.maxDevices}` : ' (bez limitu)'}
                    </Text>
                  </View>

                  {(license.usage || []).map((u) => (
                    <View key={u.mac} style={styles.card}>
                      <Text style={styles.sectionHeader}>{u.name}</Text>
                      <Text style={{ color: '#666', fontSize: 11, marginTop: -6, marginBottom: 10 }}>{u.mac}</Text>
                      {[['Karty', u.cards, u.maxCards], ['PIN-y', u.pins, u.maxPins], ['Administratorzy', u.admins, u.maxAdmins]].map(([label, used, max]) => (
                        <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#222' }}>
                          <Text style={{ color: '#ccc', fontSize: 14 }}>{label}</Text>
                          <Text style={{ color: used >= max ? '#e57373' : '#81c784', fontSize: 14, fontWeight: 'bold' }}>{used} / {max}</Text>
                        </View>
                      ))}
                    </View>
                  ))}
                </>
              )}

              <View style={styles.card}>
                <Text style={styles.sectionHeader}>Masz klucz licencyjny?</Text>
                <Text style={{ color: '#888', fontSize: 12, marginBottom: 8, lineHeight: 18 }}>
                  Wklej klucz otrzymany przy zakupie (faktura / umowa), aby odblokować wyższy pakiet.
                </Text>
                <TextInput
                  style={styles.inputField}
                  placeholder="CTRL-XXXX-XXXX-XXXX"
                  placeholderTextColor="#555"
                  autoCapitalize="characters"
                  value={licenseKeyInput}
                  onChangeText={setLicenseKeyInput}
                />
                <TouchableOpacity
                  style={[styles.secondaryBtn, { backgroundColor: '#0284c7', width: '100%', marginTop: 10, opacity: licenseBusy ? 0.5 : 1 }]}
                  disabled={licenseBusy}
                  onPress={submitLicenseKey}
                >
                  <Text style={styles.btnText}>{licenseBusy ? 'Sprawdzanie…' : '🔑 Aktywuj klucz'}</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={[styles.secondaryBtn, { width: '100%', backgroundColor: '#1a3a5c', marginTop: 4 }]}
                onPress={() => Alert.alert('Zwiększ pakiet', 'Zakup wyższego pakietu (Silver / Gold) online będzie wkrótce dostępny przez Przelewy24. Na razie napisz do nas — przydzielimy licencję i wyślemy klucz aktywacyjny.')}
              >
                <Text style={styles.btnText}>⬆️ Zwiększ pakiet</Text>
              </TouchableOpacity>

              <TouchableOpacity style={[styles.secondaryBtn, { width: '100%', marginTop: 8 }]} onPress={loadLicense}>
                <Text style={styles.btnText}>🔄 Odśwież</Text>
              </TouchableOpacity>
            </ScrollView>
          </KeyboardAvoidingView>
        )}



        {isMenuOpen && <TouchableOpacity style={styles.menuDimBackdropMask} activeOpacity={1} onPress={toggleBurgerMenu} />}
        <Animated.View style={[styles.burgerSidebarDrawerContainer, { left: menuAnimation }]}>
          <View style={styles.sidebarBrandHeaderBox}>
            <Animated.View style={{ marginRight: 10, transform: [{ scale: drawerLogoScale }] }}>
              <BrandIcon size={34} variant="dark" />
            </Animated.View>
            <Text style={styles.sidebarBrandTitleText}>Nawigacja</Text>
          </View>
          <TouchableOpacity style={[styles.menuItemRow, currentScreen === 'dashboard' ? styles.menuItemRowActive : null]} onPress={() => navigateTo('dashboard')}><Text style={styles.menuItemLabelText}>📱 Dashboard</Text></TouchableOpacity>
          <TouchableOpacity style={[styles.menuItemRow, currentScreen === 'directory' ? styles.menuItemRowActive : null]} onPress={() => navigateTo('directory')}><Text style={styles.menuItemLabelText}>👥 Lista Użytkowników</Text></TouchableOpacity>
          {!isLocalMode && (
            <TouchableOpacity
              style={[styles.menuItemRow, currentScreen === 'devices' ? styles.menuItemRowActive : null]}
              onPress={() => navigateTo('devices')}
            ><Text style={styles.menuItemLabelText}>🏠 Centralki</Text></TouchableOpacity>
          )}
          {!isLocalMode && (
            <TouchableOpacity style={[styles.menuItemRow, currentScreen === 'team' ? styles.menuItemRowActive : null]} onPress={() => { navigateTo('team'); loadTeam(); }}><Text style={styles.menuItemLabelText}>🤝 Zespół (Administratorzy)</Text></TouchableOpacity>
          )}
          {!isLocalMode && (
            <TouchableOpacity style={[styles.menuItemRow, currentScreen === 'pakiet' ? styles.menuItemRowActive : null]} onPress={() => { navigateTo('pakiet'); loadLicense(); }}><Text style={styles.menuItemLabelText}>💳 Pakiet i licencja</Text></TouchableOpacity>
          )}
          {!isLocalMode && (
            <TouchableOpacity style={[styles.menuItemRow, currentScreen === 'notifications' ? styles.menuItemRowActive : null]} onPress={() => navigateTo('notifications')}><Text style={styles.menuItemLabelText}>🔔 Powiadomienia Push</Text></TouchableOpacity>
          )}
          <TouchableOpacity style={[styles.menuItemRow, currentScreen === 'system' ? styles.menuItemRowActive : null]} onPress={() => navigateTo('system')}><Text style={styles.menuItemLabelText}>📋 Logi Systemowe</Text></TouchableOpacity>
          {!isLocalMode && (
            <TouchableOpacity style={[styles.menuItemRow, currentScreen === 'ota' ? styles.menuItemRowActive : null]} onPress={() => navigateTo('ota')}><Text style={styles.menuItemLabelText}>💾 Aktualizacja</Text></TouchableOpacity>
          )}
          <TouchableOpacity style={[styles.menuItemRow, currentScreen === 'settings' ? styles.menuItemRowActive : null]} onPress={() => navigateTo('settings')}><Text style={styles.menuItemLabelText}>⚙️ Ustawienia</Text></TouchableOpacity>
          <View style={{flex: 1}} />
          <TouchableOpacity style={styles.sidebarDisconnectBtn} onPress={handleLogout}>
            <Text style={styles.btnText}>Wyloguj się</Text>
          </TouchableOpacity>
        </Animated.View>

        {/* ── MODAL: HARMONOGRAM DOSTĘPU (dni tygodnia + okno godzinowe) ── */}
        {kpScheduleEditId !== null && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', alignItems: 'center', zIndex: 999 }}>
            <View style={{ backgroundColor: '#16161a', borderRadius: 14, padding: 20, width: '88%' }}>
              <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 17, marginBottom: 4 }}>Harmonogram dostępu</Text>
              <Text style={{ color: '#888', fontSize: 12, marginBottom: 16 }}>
                Ogranicz ten PIN do wybranych dni i godzin. Poza tym oknem PIN nie zadziała, nawet jeśli jest aktywny.
              </Text>

              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>Harmonogram włączony</Text>
                <Switch value={kpScheduleEnabled} onValueChange={setKpScheduleEnabled} trackColor={{ true: '#5c33cf' }} />
              </View>

              {kpScheduleEnabled && (
                <>
                  <Text style={styles.inputLabelText}>Dni tygodnia</Text>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 }}>
                    {DAY_LABELS.map((label, idx) => {
                      const active = (kpScheduleDays & (1 << DAY_DISPLAY_ORDER[idx])) !== 0;
                      return (
                        <TouchableOpacity
                          key={idx}
                          onPress={() => toggleScheduleDay(idx)}
                          style={{
                            width: 38, height: 38, borderRadius: 19, justifyContent: 'center', alignItems: 'center',
                            backgroundColor: active ? '#5c33cf' : '#0f0f11',
                            borderWidth: 1, borderColor: active ? '#5c33cf' : '#333',
                          }}
                        >
                          <Text style={{ color: active ? '#fff' : '#666', fontWeight: 'bold', fontSize: 12 }}>{label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  <View style={{ flexDirection: 'row', gap: 12 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.inputLabelText}>Od (GG:MM)</Text>
                      <TextInput style={styles.inputField} placeholder="08:00" placeholderTextColor="#555"
                        value={kpScheduleStartText} onChangeText={setKpScheduleStartText} maxLength={5} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.inputLabelText}>Do (GG:MM)</Text>
                      <TextInput style={styles.inputField} placeholder="20:00" placeholderTextColor="#555"
                        value={kpScheduleEndText} onChangeText={setKpScheduleEndText} maxLength={5} />
                    </View>
                  </View>
                </>
              )}

              <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
                <TouchableOpacity style={[styles.secondaryBtn, { flex: 1, backgroundColor: '#333' }]} onPress={() => setKpScheduleEditId(null)}>
                  <Text style={styles.btnText}>Anuluj</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.secondaryBtn, { flex: 1, backgroundColor: '#5c33cf' }]} onPress={saveSchedule}>
                  <Text style={styles.btnText}>Zapisz</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        {/* ── MODAL: PRZEŁĄCZNIK CENTRALEK (multi-device) ── */}
        {showDeviceSwitcher && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', alignItems: 'center', zIndex: 999 }}>
            <View style={{ backgroundColor: '#16161a', borderRadius: 14, padding: 20, width: '85%', maxHeight: '70%' }}>
              <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 17, marginBottom: 16 }}>Twoje centralki</Text>
              <ScrollView>
                {devices.map((d) => (
                  <View key={d.mac} style={{ backgroundColor: d.mac === selectedMac ? '#1a3a5c' : '#0f0f11', borderRadius: 10, padding: 12, marginBottom: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <TouchableOpacity style={{ flex: 1 }} onPress={() => { setSelectedMac(d.mac); setShowDeviceSwitcher(false); }}>
                        <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 15 }}>{d.mac === selectedMac ? '✓ ' : ''}{d.name}</Text>
                        <Text style={{ color: d.online ? '#81c784' : '#e57373', fontSize: 12, marginTop: 2 }}>
                          {d.online ? '● Online' : '● Offline'} · {d.mode || '—'}{!d.isOwner ? ' · Udostępnione Ci' : ''}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}
              </ScrollView>
              {/* Zarządzanie przeniesione do modułu „Centralki" — tu zostaje sam wybór. */}
              <TouchableOpacity style={[styles.secondaryBtn, { marginTop: 12, backgroundColor: '#1a3a5c' }]} onPress={() => { setShowDeviceSwitcher(false); navigateTo('devices'); }}>
                <Text style={styles.btnText}>🏠 Zarządzaj centralkami</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.secondaryBtn, { marginTop: 8 }]} onPress={() => setShowDeviceSwitcher(false)}>
                <Text style={styles.btnText}>Zamknij</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── MODAL: ZMIANA NAZWY CENTRALKI (cross-platform, TextInput) ── */}
        {renameDeviceMac !== null && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ width: '85%' }}>
              <View style={{ backgroundColor: '#16161a', borderRadius: 14, padding: 20 }}>
                <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 17, marginBottom: 6 }}>Nazwa centralki</Text>
                <Text style={{ color: '#888', fontSize: 12, marginBottom: 14 }}>Nadaj własną nazwę, np. „Drzwi wejściowe", „Garaż", „Biuro".</Text>
                <TextInput
                  style={styles.inputField}
                  placeholder="Nazwa centralki"
                  placeholderTextColor="#555"
                  value={renameDeviceInput}
                  onChangeText={setRenameDeviceInput}
                  autoFocus
                  maxLength={40}
                  returnKeyType="done"
                  onSubmitEditing={submitRenameDevice}
                />
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
                  <TouchableOpacity style={[styles.secondaryBtn, { flex: 1 }]} onPress={() => { setRenameDeviceMac(null); setRenameDeviceInput(''); }}>
                    <Text style={styles.btnText}>Anuluj</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.secondaryBtn, { flex: 1, backgroundColor: '#5c33cf' }]} onPress={submitRenameDevice}>
                    <Text style={styles.btnText}>Zapisz</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </KeyboardAvoidingView>
          </View>
        )}

        {/* ── MODAL: MAM KOD ZAPROSZENIA (cross-platform, TextInput) ── */}
        {acceptCodeVisible && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ width: '85%' }}>
              <View style={{ backgroundColor: '#16161a', borderRadius: 14, padding: 20 }}>
                <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 17, marginBottom: 6 }}>Mam kod zaproszenia</Text>
                <Text style={{ color: '#888', fontSize: 12, marginBottom: 14 }}>Wpisz 6-cyfrowy kod otrzymany e-mailem, aby uzyskać dostęp do udostępnionej centralki.</Text>
                <TextInput
                  style={styles.inputField}
                  placeholder="np. 482913"
                  placeholderTextColor="#555"
                  value={acceptCodeInput}
                  onChangeText={setAcceptCodeInput}
                  autoFocus
                  keyboardType="number-pad"
                  maxLength={6}
                  returnKeyType="done"
                  onSubmitEditing={submitAcceptCode}
                />
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
                  <TouchableOpacity style={[styles.secondaryBtn, { flex: 1 }]} onPress={() => { setAcceptCodeVisible(false); setAcceptCodeInput(''); }}>
                    <Text style={styles.btnText}>Anuluj</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.secondaryBtn, { flex: 1, backgroundColor: '#5c33cf' }]} onPress={submitAcceptCode}>
                    <Text style={styles.btnText}>Dołącz</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </KeyboardAvoidingView>
          </View>
        )}

        {/* ── MODAL: DEREGISTRACJA CENTRALKI (2 kroki, potwierdzenie kodem z maila) ── */}
        {deregVisible && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ width: '85%' }}>
              <View style={{ backgroundColor: '#16161a', borderRadius: 14, padding: 20, borderColor: '#5c1a1a', borderWidth: 1 }}>
                <Text style={{ color: '#e57373', fontWeight: 'bold', fontSize: 17, marginBottom: 6 }}>🔌 Odłączenie centralki</Text>
                {deregStep === 'request' ? (
                  <>
                    <Text style={{ color: '#aaa', fontSize: 13, marginBottom: 16, lineHeight: 19 }}>
                      To trwale odłączy i zresetuje centralkę: wyczyści jej WiFi, konto i karty RFID, po czym wróci do trybu CTRLABLE_SETUP. Wyślemy kod potwierdzający na Twój e-mail.
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <TouchableOpacity style={[styles.secondaryBtn, { flex: 1 }]} onPress={() => setDeregVisible(false)}>
                        <Text style={styles.btnText}>Anuluj</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[styles.secondaryBtn, { flex: 1, backgroundColor: '#7f1d1d', opacity: deregBusy ? 0.5 : 1 }]} disabled={deregBusy} onPress={requestDeregisterCode}>
                        <Text style={styles.btnText}>{deregBusy ? 'Wysyłanie…' : 'Wyślij kod'}</Text>
                      </TouchableOpacity>
                    </View>
                  </>
                ) : (
                  <>
                    <Text style={{ color: '#aaa', fontSize: 13, marginBottom: 12, lineHeight: 19 }}>
                      Wpisz 6-cyfrowy kod wysłany na Twój e-mail, aby potwierdzić trwałe odłączenie centralki.
                    </Text>
                    <TextInput
                      style={styles.inputField}
                      placeholder="np. 482913"
                      placeholderTextColor="#555"
                      value={deregCodeInput}
                      onChangeText={setDeregCodeInput}
                      autoFocus
                      keyboardType="number-pad"
                      maxLength={6}
                      returnKeyType="done"
                      onSubmitEditing={submitDeregisterConfirm}
                    />
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
                      <TouchableOpacity style={[styles.secondaryBtn, { flex: 1 }]} onPress={() => { setDeregVisible(false); setDeregCodeInput(''); }}>
                        <Text style={styles.btnText}>Anuluj</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[styles.secondaryBtn, { flex: 1, backgroundColor: '#7f1d1d', opacity: deregBusy ? 0.5 : 1 }]} disabled={deregBusy} onPress={submitDeregisterConfirm}>
                        <Text style={styles.btnText}>{deregBusy ? 'Odłączanie…' : 'Potwierdź odłączenie'}</Text>
                      </TouchableOpacity>
                    </View>
                  </>
                )}
              </View>
            </KeyboardAvoidingView>
          </View>
        )}

      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  darkContainer: { flex: 1, backgroundColor: '#0f0f11' },
  navigationHeaderBar: { height: 60, backgroundColor: '#16161a', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#222' },
  burgerIconTouchContainer: { width: 30, height: 30, justifyContent: 'center' },
  burgerStripeLine: { width: 22, height: 2.5, backgroundColor: '#fff', borderRadius: 2 },
  headerTitleText: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  headerBrandRow: { flexDirection: 'row', alignItems: 'center' },
  scrollWrapper: { padding: 16, paddingBottom: 40 },
  screenHeaderText: { fontSize: 20, fontWeight: 'bold', color: '#fff', marginBottom: 16, letterSpacing: 0.3 },
  authCard: { padding: 24, backgroundColor: '#16161a', borderRadius: 16, marginTop: 40, marginHorizontal: 8, alignItems: 'center', borderWidth: 1, borderColor: '#222' },
  authLogoIcon: { marginBottom: 12 },
  tamperBanner: {
    backgroundColor: '#7f1d1d',
    borderWidth: 2,
    borderColor: '#ef4444',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  tamperBannerTitle: {
    color: '#fca5a5',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  tamperBannerBody: {
    color: '#fecaca',
    fontSize: 13,
    lineHeight: 20,
  },
  titleText: { fontSize: 22, fontWeight: 'bold', color: '#fff', textAlign: 'center', marginBottom: 24 },
  installerBoxContainer: { width: '100%', padding: 12, backgroundColor: '#1c1917', borderRadius: 12, marginBottom: 20, borderWidth: 1, borderColor: '#7c2d12' },
  installerTitleText: { color: '#ef4444', fontWeight: 'bold', fontSize: 13, textTransform: 'uppercase', marginBottom: 12 },
  sectionHeader: { fontSize: 13, fontWeight: 'bold', color: '#64b5f6', marginBottom: 14, letterSpacing: 0.5, textTransform: 'uppercase' },
  inputLabelText: { color: '#888', fontSize: 13, marginBottom: 10, alignSelf: 'flex-start' },
  inputField: { backgroundColor: '#202024', color: '#fff', padding: 16, borderRadius: 10, marginBottom: 16, fontSize: 16, borderWidth: 1, borderColor: '#2d2d34', width: '100%' },
  primaryBtn: { backgroundColor: '#5c33cf', padding: 16, borderRadius: 10, alignItems: 'center', marginTop: 8, width: '100%' },
  secondaryBtn: { padding: 14, borderRadius: 10, alignItems: 'center', marginTop: 4 },
  inlineBtn: { padding: 12, borderRadius: 8, width: '47%', alignItems: 'center' },
  actionTriggerBtn: { padding: 18, borderRadius: 12, alignItems: 'center', marginVertical: 16 },
  btnText: { color: '#fff', fontWeight: 'bold', fontSize: 15 },
  card: { backgroundColor: '#16161a', padding: 16, borderRadius: 14, marginBottom: 16, borderWidth: 1, borderColor: '#222' },
  statusBox: { backgroundColor: '#16161a', padding: 18, borderRadius: 14, alignItems: 'center', borderWidth: 1, borderColor: '#222' },
  label: { color: '#666', fontSize: 13 },
  valueBold: { fontSize: 17, fontWeight: 'bold', marginVertical: 6, textAlign: 'center' },
  subLabel: { color: '#444', fontSize: 12 },
  learningAlertText: { color: '#ffb300', fontSize: 14, fontWeight: 'bold', textAlign: 'center', marginVertical: 12 },
  errorCard: { backgroundColor: '#281515', borderWidth: 1, borderColor: '#4c2222', padding: 12, borderRadius: 10, marginBottom: 16 },
  errorTextInsideCard: { color: '#ff8888', fontSize: 13, fontWeight: 'bold', textAlign: 'center' },
  userRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#222' },
  userName: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  userUid: { color: '#555', fontSize: 12, fontFamily: 'monospace', marginTop: 3 },
  rowActions: { flexDirection: 'row', alignItems: 'center' },
  internalLogBox: { maxHeight: 400, marginTop: 4 },
  logText: { color: '#81c784', fontFamily: 'monospace', fontSize: 12, marginVertical: 4 },
  errorBanner: { color: '#ff6b6b', textAlign: 'center', marginTop: 16, fontWeight: 'bold' },
  burgerSidebarDrawerContainer: { position: 'absolute', top: 0, bottom: 0, width: width * 0.75, backgroundColor: '#141417', zIndex: 100, padding: 16, borderRightWidth: 1, borderRightColor: '#222' },
  menuDimBackdropMask: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 99 },
  sidebarBrandHeaderBox: { flexDirection: 'row', alignItems: 'center', paddingVertical: 20, borderBottomWidth: 1, borderBottomColor: '#222', marginBottom: 20 },
  sidebarBrandTitleText: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  menuItemRow: { paddingVertical: 16, paddingHorizontal: 12, borderRadius: 8, marginBottom: 8 },
  menuItemRowActive: { backgroundColor: '#202026' },
  menuItemLabelText: { color: '#ccc', fontSize: 16, fontWeight: '600' },
  sidebarDisconnectBtn: { backgroundColor: '#1e1b1b', padding: 14, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: '#3f1a1a' },
  checkboxContainer: { flexDirection: 'row', alignItems: 'flex-start', marginVertical: 16, paddingHorizontal: 4, width: '100%'},
  checkboxSquare: { width: 22, height: 22, borderWidth: 2, borderColor: '#64b5f6', borderRadius: 4, justifyContent: 'center', alignItems: 'center', marginRight: 12, marginTop: 2},
  checkboxSquareChecked: { backgroundColor: '#5c33cf', borderColor: '#5c33cf' },
  checkboxCheckmark: { color: '#ffffff', fontWeight: 'bold', fontSize: 14 },
  checkboxLabel: { color: '#aaa', fontSize: 12, lineHeight: 18, flex: 1 },
  hyperlinkText: { color: '#64b5f6', fontWeight: 'bold', textDecorationLine: 'underline' },
});