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
  let [backendUrl, setBackendUrl] = useState('http://185.101.191.76:3000'); 
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accountId, setAccountId] = useState(null);    // kept for local-mode compat
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
  const [pushAlarms, setPushAlarms] = useState(true);

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
  const [authStep, setAuthStep] = useState('connect');
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
    otaProgress: 0 
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
      
      // Dopasowanie do Twojego formatu odpowiedzi: data.status === "registered"
      if (data.status === "registered") {
        Alert.alert("Sukces", "Konto Master zostało pomyślnie utworzone! Sprawdź swoją skrzynkę e-mail.");
        setAuthStep('login'); // Przełączenie widoku na panel logowania
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

  const handleSecurityLogin = async () => {
    if (!email || !password) return;
    setIsAuthenticating(true);
    setErrorMessage('Processing identity authentication flags...');

    fetch(`${backendUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password: password.trim() })
    })
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then(async (data) => {
        setIsAuthenticating(false);
        if (data.auth && (data.token || data.accountId)) {
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
    try {
      // 1. Informujemy backend na Proxmoxie, żeby wyłączył pushe dla tego konta
      if (authToken) {
        await fetch(`${backendUrl}/api/auth/save_push_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
          body: JSON.stringify({ token: 'LOGGED_OUT' })
        });
      }

      // 2. Czyścimy pamięć lokalną sesji w telefonie (konto w chmurze i/lub Tryb Lokalny)
      await AsyncStorage.removeItem('@lock_account_id');
      await AsyncStorage.removeItem('@lock_auth_token');
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
        alert('Błąd sieciowy podczas wywoływania SMTP.');
      });
  };

  const handleVerifyResetCode = () => {
    if (!resetCode) return Alert.alert('Błąd', 'Wpisz 6-cyfrowy kod z wiadomości e-mail!');
    setIsAuthenticating(true);
    setErrorMessage('Autoryzacja kodu zabezpieczającego...');

    fetch(`${backendUrl}/api/auth/verify_reset_code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), code: resetCode.trim() })
    })
      .then(async (res) => {
        setIsAuthenticating(false);
        const data = await res.json();
        if (res.status === 200 && data.valid) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          setResetStep(3); // Kod zmatchowany -> Odblokuj formularz nowego hasła
          setErrorMessage('');
        } else {
          Alert.alert('Odmowa dostępu', data.error || 'Kod jest nieprawidłowy lub wygasł.');
        }
      })
      .catch(() => {
        setIsAuthenticating(false);
        alert('Błąd komunikacji z chmurą.');
      });
  };

  const handleConfirmPasswordReset = () => {
    if (!newPassword || !confirmNewPassword) return Alert.alert('Błąd', 'Wypełnij pola nowego hasła!');
    if (newPassword !== confirmNewPassword) return Alert.alert('Błąd', 'Wprowadzone hasła nie są identyczne!');
    setIsAuthenticating(true);
    setErrorMessage('Zapisywanie nowego klucza master...');

    fetch(`${backendUrl}/api/auth/confirm_password_reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), code: resetCode.trim(), newPassword: newPassword.trim() })
    })
      .then(async (res) => {
        setIsAuthenticating(false);
        const data = await res.json();
        if (res.status === 200 && data.success) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Alert.alert('Sukces', 'Hasło zostało zmienione. Możesz się zalogować.');
          setIsForgotPasswordMode(false);
          setResetStep(1);
          setResetCode('');
          setNewPassword('');
          setConfirmNewPassword('');
          setErrorMessage('');
        } else {
          Alert.alert('Błąd', data.error || 'Modyfikacja odrzucona przez serwer.');
        }
      })
      .catch(() => {
        setIsAuthenticating(false);
        alert('Błąd transakcji bazodanowej.');
      });
  };

  const handleSaveSystemSettings = () => {
  // 1. Obsługa zmiany hasła do konta w aplikacji
  if (settingsAppPass) {
    fetch(`${backendUrl}/api/settings/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, newPassword: settingsAppPass })
    })
      .then((res) => {
        if (!res.ok) throw new Error();
        Alert.alert("Sukces", "Twoje hasło do aplikacji zostało pomyślnie zmienione.");
      })
      .catch(() => alert("Błąd podczas zmiany hasła do aplikacji."));
  }

  // 2. Obsługa zmiany sieci Wi-Fi w centralce
  if (settingsSsid) {
    fetch(`${backendUrl}/api/settings/wifi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, wifiSSID: settingsSsid, wifiPass: settingsWifiPass })
    })
      .then(() => Alert.alert("Zapisano", "Nowa konfiguracja Wi-Fi wysłana. Zamek uruchamia się ponownie."))
      .catch(() => alert("Błąd synchronizacji Wi-Fi z hardware."));
  }

  // Czyszczenie pól formularza
  setSettingsWifiPass('');
  setSettingsAppPass(''); // <-- Czyszczenie nowego stanu
  setSettingsSsid('');
};

  //LOGIKA WYKRYWANIA I ANALIZY AKTUALIZACJI OTA
  const handleCheckUpdate = () => {
    setOtaState('checking');
    fetch(`${backendUrl}/api/firmware/version`)
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then((data) => {
        // Zapisywanie numeru wersji z GitHuba do stanu, aby użyć go w tekście UI
        setLatestVersion(data.latestVersion);

        const currentVer = (lockState.version || '0.0.0').replace(/v\.?/g, '').trim();
        const latestVer = data.latestVersion.replace(/v\.?/g, '').trim();
        
        if (currentVer === latestVer) {
          setOtaState('up-to-date');
          
          setTimeout(() => {
            setOtaState('idle');
          }, 5000);

        } else {
          setOtaState('available');
        }
      })
      .catch(() => {
        setOtaState('idle');
        Alert.alert('Błąd systemu', 'Nie udało się pobrać danych o plikach binarnych z Serwera.');
      });
  };

  // URUCHOMIENIE PROCESU AKTUALIZACJI NODE ORAZ ZAMKA
  const handleExecuteUpdate = () => {
    setOtaState('downloading_server');

    // Wysłanie zapytania GET do serwera
    fetch(`${backendUrl}/api/ota/push`, { method: 'GET' })
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then((data) => {
        if (data.success) {
          // Serwer pobrał plik. Teraz informujemy, że zamek instaluje oprogramowanie z sieci LAN.
          setOtaState('flashing_device');

          let attempts = 0;
          const checkInterval = setInterval(() => {
            attempts++;
            
            // Pobieramy świeży stan z serwera (on odpytuje bazę SQL)
            fetchStatus(); 

            // 🌟 Czytamy z REFA, nie z domknięcia "lockState" złapanego w chwili
            // kliknięcia "Aktualizuj" - inaczej ten warunek nigdy nie zauważy
            // zmiany wersji, choćby aktualizacja faktycznie się powiodła.
            // Normalizujemy obie strony (usuwamy ewentualny prefiks "v"), żeby
            // drobna niezgodność formatu też nie generowała fałszywego timeoutu.
            const normalizeVer = (v) => (v || '').replace(/v\.?/g, '').trim();
            if (normalizeVer(lockStateRef.current.version) === normalizeVer(latestVersion)) {
              clearInterval(checkInterval);
              setOtaState('success');
              setTimeout(() => setOtaState('idle'), 5000);
            }

            // Bezpiecznik: jeśli po 45 sekundach zamek nie wstał, wyłączamy pętlę i sypiemy błędem
            if (attempts > 15) {
              clearInterval(checkInterval);
              setOtaState('available');
              Alert.alert('Timeout', 'Centralka pobrała plik, ale nie potwierdziła jego instalacji \n Spróbuj ponownie lub zrestartuj urządzenie.');
            }
          }, 3000); 

        } else {
          throw new Error();
        }
      })
      .catch(() => {
        // W razie błędu wracamy do opcji ponownego kliknięcia
        setOtaState('available');
        Alert.alert('Błąd aktualizacji', 'Serwer nie mógł pobrać stabilnego pliku z serwera.');
      });
  };

  // Scala nową odpowiedź z poprzednim stanem, chroniąc optymistyczny stan
  // 'pending' przed nadpisaniem przez chwilowo nieaktualne 'false' - serwer
  // / centralka mogły jeszcze nie zdążyć przetworzyć komendy odblokowania.
  // Bez tego UI potrafiło pokazać "zamknięty" na chwilę i nigdy nie złapać
  // momentu, w którym zamek faktycznie się otwiera.
  const mergeLockState = (prevState, data) => {
    let nextLock = data.lock;
    if (
      prevState.lock === 'pending' &&
      data.lock === false &&
      Date.now() - pendingUnlockSinceRef.current < 4000
    ) {
      nextLock = 'pending';
    }
    return {
      ...prevState,
      ...data,
      lock: nextLock,
      version: data.version || prevState.version || '2.9.4',
    };
  };

  const fetchStatus = useCallback(() => {
  if (!isConfigured) return;

  if (isLocalMode) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    fetch(`${LOCAL_BASE_URL}/api/data?pass=${encodeURIComponent(localAdminPass)}`, { signal: controller.signal })
      .then((res) => {
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error('Network response was not ok');
        return res.json();
      })
      .then((data) => {
        if (data.auth === false) {
          setErrorMessage('Lokalne hasło administratora jest nieprawidłowe.');
          return;
        }
        setErrorMessage('');
        setLockState(prevState => mergeLockState(prevState, data));
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        setLockState(prevState => ({ ...prevState, lock: 'offline' }));
        setErrorMessage('Brak połączenia z centralką (Offline)');
        console.error('Fetch status error (local):', err.message);
      });
    return;
  }

  if (!accountId) return;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);

  fetch(`${backendUrl}/api/data`, {
    signal: controller.signal,
    headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
  })
    .then((res) => {
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error('Network response was not ok');
      return res.json();
    })
    .then((data) => {
      setErrorMessage(''); 
      
      if (data.pushEntries !== undefined) setPushEntries(data.pushEntries);
      if (data.pushAlarms !== undefined) setPushAlarms(data.pushAlarms);
      
      if (data.auth === false) {
        setIsConfigured(false);
      } else {
        setLockState(prevState => mergeLockState(prevState, data));
      }
    })
    .catch((err) => {
      clearTimeout(timeoutId);
      
      setLockState(prevState => ({
        ...prevState,
        lock: 'offline' 
      }));
      
      setErrorMessage(`Brak połączenia z centralką (Offline)`);
      console.error("Fetch status error:", err.message);
    });
}, [isConfigured, accountId, backendUrl, isLocalMode, localAdminPass]);

  const executeCommand = (endpoint, payload = null) => {
  // Wywołujemy Twoją haptykę (wibrację) natychmiast po dotknięciu
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
      .catch((error) => {
        if (endpoint === '/api/unlock') {
          setLockState(prevState => ({ ...prevState, lock: false }));
        }
        setErrorMessage(`Transaction failure: ${error.message}`);
      });
    return;
  }

  const method = payload ? 'POST' : 'GET';
  // Build auth headers — prefer the signed JWT; fall back gracefully if it
  // hasn't arrived yet (e.g. older server or session restored from old storage).
  const authHeader = authToken ? { 'Authorization': `Bearer ${authToken}` } : {};
  const config = {
    method: method,
    headers: payload
      ? { 'Content-Type': 'application/json', ...authHeader }
      : { ...authHeader }
  };
  // Remove accountId from the body — the server now reads it from the JWT.
  if (payload) {
    const { accountId: _dropped, ...safePayload } = payload;
    config.body = JSON.stringify(safePayload);
  }

  // GET requests no longer append ?accountId= — the Authorization header carries identity.
  fetch(`${backendUrl}${endpoint}`, config)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP status ${res.status}`);
      
      fetchStatus();
    })
    .catch((error) => {
      if (endpoint === '/api/unlock') {
        setLockState(prevState => ({ ...prevState, lock: false }));
      }
      
      setErrorMessage(`Transaction failure: ${error.message}`);
    });
};


  const handleToggleLearn = () => {
    if (lockState.mode === 'Uczenie') {
      executeCommand('/api/toggle_learn');
    } else {
      const targetFallbackLabel = newName.trim() ? newName.trim() : 'Nowy Uzytkownik';
      executeCommand(`/api/toggle_learn?username=${encodeURIComponent(targetFallbackLabel)}`);
      setNewName('');
    }
  };

  const promptUserRename = (idx, currentName) => {
    Alert.prompt(
      "Edytuj Nazwę",
      "Wprowadź nową nazwę użytkownika " + currentName + ":",
      [
        { text: "Anuluj", style: "cancel" },
        { 
          text: "Zapisz", 
          onPress: (newNameText) => {
            if(newNameText && newNameText.trim().length > 0) {
              executeCommand('/api/user/rename', { idx, name: newNameText.trim() });
            }
          } 
        }
      ],
      "plain-text",
      currentName
    );
  };

  // Powiadomienia Push

  const registerForPushNotificationsAsync = async (targetAccountId) => {
  
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  
  if (finalStatus !== 'granted') {
    console.log('Brak uprawnień do powiadomień push. Generuję token ratunkowy...');
  }
  
  try {
    let token = "";
    
    // Próba pobrania prawdziwego tokenu (zadziała na fizycznym telefonie w Expo Go)
    if (finalStatus === 'granted' && Device.isDevice) {
      try {
        console.log('--- Rozpoczynam fizyczne żądanie tokenu z chmury Expo ---');
        
        // Wywołanie z jawnie podanym projectId (jeśli go posiadasz)
        // Jeśli nie masz skonfigurowanego konta Expo EAS, ta funkcja rzuci błędem.
        const tokenData = await Notifications.getExpoPushTokenAsync();
        
        token = tokenData.data;
        console.log('✅ Sukces! Pobrano sprzętowy token:', token);
      } catch (e) {
        // 🚨 WYCIĄGAMY BŁĄD NA WIERZCH:
        console.error('❌ Krytyczny błąd wewnątrz getExpoPushTokenAsync:', e.message);
        console.log('⚠️ Uruchamiam tryb awaryjny (Fallback do SnackSimulated)');
        
        token = `ExponentPushToken[SnackSimulated_${targetAccountId}]`;
      }
    } else {
        // Brak uprawnień lub web/emulator -> wymuszamy token symulacyjny
        token = `ExponentPushToken[SnackSimulated_${targetAccountId}]`;
      }

      // Wysyłamy token bezpośrednio na Twój serwer Proxmox
      const response = await fetch(`${backendUrl}/api/auth/save_push_token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
        },
        body: JSON.stringify({ token })
      });
      
      const resData = await response.json();
      if (resData.success) {
        console.log('Zsynchronizowano token push:', token);
      }
    } catch (error) {
    console.log('Błąd krytyczny potoku rejestracji push:', error);
    }
  };

  useEffect(() => {
    const bootstrapAsyncState = async () => {
      try {
        // KROK A: Pobieramy adres URL centralki
        const storedUrl = await AsyncStorage.getItem('@lock_backend_endpoint');
        
        if (storedUrl) {
          setBackendUrl(storedUrl);
          setInstallerUrlInput(storedUrl);
          setCurrentScreen('login'); 
        } else {
          setInstallerUrlInput(backendUrl);
          // Brak adresu -> interfejs naturalnie zostanie na ekranie parowania
        }

        // KROK A.2: Czy urządzenie zostało skonfigurowane w Trybie Lokalnym (Offline)?
        const storedLocalMode = await AsyncStorage.getItem('@lock_local_mode');
        const storedLocalPass = await AsyncStorage.getItem('@lock_local_admin_pass');

        if (storedLocalMode === '1' && storedLocalPass) {
          setIsLocalMode(true);
          setLocalAdminPass(storedLocalPass);
          resetUiToDefault();
          setIsConfigured(true); // Wpuszczamy do Dashboardu - bez konta w chmurze
        } else {
          // KROK B: Pobieramy ID konta (czy jest zalogowany) - tylko w trybie chmury
          const storedAccountId = await AsyncStorage.getItem('@lock_account_id');
          const storedToken     = await AsyncStorage.getItem('@lock_auth_token');

          if (storedToken || storedAccountId) {
            if (storedToken)     setAuthToken(storedToken);
            if (storedAccountId) setAccountId(parseInt(storedAccountId, 10));
            resetUiToDefault();
            setIsConfigured(true);
            registerForPushNotificationsAsync(storedAccountId ? parseInt(storedAccountId, 10) : null);
          }
        }
      } catch (e) {
        console.error("Błąd odczytu pamięci podręcznej:", e);
      } finally {
        // Zamykamy ekran ładowania - AsyncStorage zakończył pracę
        setIsLoading(false);
      }
    };
    
    bootstrapAsyncState();
    
  }, [resetUiToDefault]); 

  useEffect(() => {
  if (!isConfigured || (!accountId && !isLocalMode)) return;

  fetchStatus(); // Pobierz stan od razu
  
  const dynamicIntervalTime = (lockState.lock === true || lockState.lock === 'pending') ? 500 : 3000;
  
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
      if (authStep === 'connect') return 'Połączenie Węzła';
      if (authStep === 'onboarding') return 'Inicjalizacja Centralki';
      if (authStep === 'forgot') return `Odzyskiwanie [Krok ${resetStep}/3]`;
      if (authStep === 'register') return 'Rejestracja Konta Master';
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

          {/* =========================================================================
              KROK 1: RYGORYSTYCZNY EKRAN STARTOWY Z INTEGRACJĄ SYSTEMOWĄ WI-FI
              ========================================================================= */}
          {authStep === 'connect' && (
            <>
              <Text style={[styles.inputLabelText, { textAlign: 'center', marginBottom: 24, alignSelf: 'center', color: '#aaa', lineHeight: 18 }]}>
                Wykryto pierwszy rozruch struktury. Aby uniemożliwić nieautoryzowany dostęp, funkcje rejestru i logowania są zablokowane do momentu wykrycia fizycznego modułu w Twoim otoczeniu.
              </Text>
              
              {isScanning ? (
                <View style={{ alignItems: 'center', marginVertical: 24, width: '100%' }}>
                  <LoadingPulse size={48} />
                  <Text style={{ color: '#64b5f6', fontWeight: 'bold', fontSize: 16, marginTop: 10, marginBottom: 6 }}>Inicjalizacja magistrali radiowej...</Text>
                  <Text style={{ color: '#555', fontSize: 12, textAlign: 'center' }}>
                    Wywoływanie uprawnień sieciowych i próba spięcia z węzłem CTRLABLE_SETUP...
                  </Text>
                </View>
              ) : (
                <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: '#5c33cf', marginVertical: 10 }]} onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  
                  // 1. Zgoda na sieć lokalną (Local Network Privacy)
                  Alert.alert(
                    "Uprawnienia sieciowe",
                    "Aplikacja CTRLABLE wymaga dostępu do sieci lokalnej, aby wykrywać i zarządzać węzłami zabezpieczeń w Twoim otoczeniu.",
                    [
                      { text: "Odmów", style: "cancel", onPress: () => {
                        setErrorMessage("Błąd: Brak uprawnień do sieci lokalnej. Konfiguracja zablokowana.");
                      }},
                      { text: "Zezwól", onPress: () => {
                        setErrorMessage(null); // Czyszczenie starych błędów
                        setIsScanning(true);

                        // 2. Wywołanie systemowego monitu o dołączenie do konkretnego SSID (Symulacja NEHotspotConfiguration dla Expo Go)
                        setTimeout(() => {
                          Alert.alert(
                            "Połączenie Wi-Fi",
                            "Aplikacja CTRLABLE chce dołączyć do sieci Wi-Fi „CTRLABLE_SETUP” nadawanej przez bliską centralkę. Czy wyrażasz zgodę?",
                            [
                              { text: "Anuluj", style: "cancel", onPress: () => {
                                setIsScanning(false);
                                setErrorMessage("Połączenie przerwane przez użytkownika.");
                              }},
                              { text: "Połącz", onPress: () => {
                                // Telefon "przełącza" się na sieć centralki i zaczyna pukać do jej bramy (192.168.4.1)
                                const controller = new AbortController();
                                const timeoutId = setTimeout(() => controller.abort(), 3500); // Rygorystyczne 3.5 sekundy na odpowiedź

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
                                    
                                    // ZWROT BŁĘDU ZGODNIE Z WYMAGANIAMI: Powrót do ekranu z jasnym komunikatem
                                    setErrorMessage("Nie znaleziono w zasięgu centralki. Proszę się upewnić, że jest podłączona do zasilania i nadaje sygnał.");
                                  });
                              }}
                            ]
                          );
                        }, 1200); // Opóźnienie dla płynności animacji UX
                      }}
                    ]
                  );
                }}>
                  <Text style={styles.btnText}>⚡ Połącz z centralką</Text>
                </TouchableOpacity>
              )}

              {/* Ukryta furtka dla dewelopera / powracającego klienta */}
              <TouchableOpacity style={{ marginTop: 24 }} onPress={() => setAuthStep('login')}>
                <Text style={{ color: '#444', fontSize: 12, fontWeight: '600', textAlign: 'center' }}>
                  Moje urządzenie jest już podłączone do sieci domowej ➔
                </Text>
              </TouchableOpacity>
            </>
          )}

          {/* =========================================================================
              KROK 2: KARTA INICJALIZACJI CENTRALKI (DOSTĘPNA PO SPAROWANIU)
              ========================================================================= */}
          {authStep === 'onboarding' && (
            <>
              <Text style={[styles.inputLabelText, { textAlign: 'center', marginBottom: 20, alignSelf: 'center', color: '#ffb300' }]}>
                Aplikacja przygotowuje połączenie sieciowe. Połącz się w ustawieniach telefonu z Wi-Fi: CTRLABLE_SETUP i uzupełnij poniższy profil:
              </Text>

              <Text style={styles.inputLabelText}>Nazwa domowej sieci Wi-Fi (SSID):</Text>
              <TextInput style={styles.inputField} placeholder="Wpisz nazwę sieci Wi-Fi" placeholderTextColor="#444" value={settingsSsid} onChangeText={setSettingsSsid} />
              
              <Text style={styles.inputLabelText}>Hasło do domowej sieci Wi-Fi:</Text>
              <TextInput style={styles.inputField} placeholder="Wpisz hasło Wi-Fi" placeholderTextColor="#444" secureSetSecureLoginEntry value={settingsWifiPass} onChangeText={setSettingsWifiPass} />

              <Text style={[styles.sectionHeader, { marginTop: 10 }]}>Konfiguracja Profilu Administratora</Text>
              <Text style={styles.inputLabelText}>Adres E-mail:</Text>
              <TextInput style={styles.inputField} placeholder="nazwa@domena.pl" keyboardType="email-address" autoCapitalize="none" placeholderTextColor="#444" value={email} onChangeText={setEmail} />
              
              <Text style={styles.inputLabelText}>Hasło dostępowe:</Text>
              <TextInput style={styles.inputField} placeholder="••••••••" placeholderTextColor="#444" secureTextEntry value={password} onChangeText={setPassword} />

              <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: '#2e7d32' }, isAuthenticating ? { opacity: 0.6 } : null]} disabled={isAuthenticating} onPress={() => {
                fetch(`http://192.168.4.1/save_setup?s=${encodeURIComponent(settingsSsid)}&p=${encodeURIComponent(settingsWifiPass)}&m=${encodeURIComponent(email)}&reg_pass=${encodeURIComponent(password)}&offline=0`)
                  .then(() => {
                    Alert.alert("Konfiguracja wysłana", "Centralka restartuje się w celu wpięcia do sieci domowej. Możesz się teraz zalogować.");
                    setAuthStep('login');
                  })
                  .catch(() => Alert.alert("Błąd połączenia", "Nie można dostarczyć pakietów do 192.168.4.1. Sprawdź czy telefon jest w sieci CTRLABLE_SETUP."));
              }}>
                <Text style={styles.btnText}>Zapisz i Utwórz Konto</Text>
              </TouchableOpacity>

              <View style={{ flexDirection: 'row', alignItems: 'center', width: '100%', marginVertical: 18 }}>
                <View style={{ flex: 1, height: 1, backgroundColor: '#222' }} />
                <Text style={{ color: '#555', fontSize: 12, marginHorizontal: 10 }}>ALBO</Text>
                <View style={{ flex: 1, height: 1, backgroundColor: '#222' }} />
              </View>

              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: '#1c1917', borderWidth: 1, borderColor: '#444' }, isAuthenticating ? { opacity: 0.6 } : null]}
                disabled={isAuthenticating}
                onPress={() => {
                  Alert.alert(
                    "Tryb Lokalny (bez internetu)",
                    "Centralka nigdy nie połączy się z internetem ani z chmurą. Karty RFID i przycisk fizyczny będą działać od razu, a zarządzanie z aplikacji odbędzie się przez sieć Wi-Fi samej centralki. Nie potrzebujesz konta e-mail. Kontynuować?",
                    [
                      { text: "Anuluj", style: "cancel" },
                      { text: "Tak, ustaw lokalnie", onPress: handleOfflineSetup }
                    ]
                  );
                }}
              >
                <Text style={styles.btnText}>🔌 Skonfiguruj bez internetu (Tryb Lokalny)</Text>
              </TouchableOpacity>

              <TouchableOpacity style={{ marginTop: 20 }} onPress={() => { setAuthStep('connect'); setDetectedDevice(false); }}>
                <Text style={{ color: '#64b5f6', fontWeight: 'bold', fontSize: 13, textAlign: 'center' }}>⬅ Powrót do skanowania</Text>
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

              <TouchableOpacity style={{ marginTop: 14 }} onPress={() => setAuthStep('register')}>
                <Text style={{ color: '#aaa', fontSize: 13, textAlign: 'center' }}>Nie masz konta? Zarejestruj nową przestrzeń</Text>
              </TouchableOpacity>

              <TouchableOpacity style={{ marginTop: 24, padding: 10, borderWidth: 1, borderColor: '#333', borderRadius: 8, width: '100%' }} onPress={() => { setAuthStep('connect'); setDetectedDevice(false); }}>
                <Text style={{ color: '#ef4444', fontSize: 12, fontWeight: 'bold', textAlign: 'center' }}>⚙️ Rozłącz z obecnym węzłem</Text>
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
              
              <TouchableOpacity style={[styles.primaryBtn, isAuthenticating ? {backgroundColor: '#333'} : null]} onPress={() => {
                handleAccountRegistration();
                setAuthStep('login');
              }} disabled={isAuthenticating}>
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
                    onPress={() => Alert.alert("Placeholder", "Przekierowanie do: https://ctrlable.node/terms (Strona w budowie)")}
                  >
                    Regulamin Serwisu
                  </Text>
                  {' '}oraz{' '}
                  <Text 
                    style={styles.hyperlinkText} 
                    onPress={() => Alert.alert("Placeholder", "Przekierowanie do: https://ctrlable.node/privacy (Strona w budowie)")}
                  >
                    Politykę Prywatności
                  </Text>
                  , w tym wyrażam zgodę na przetwarzanie moich danych osobowych (takich jak adres e-mail oraz historia zdarzeń otwarcia rygla) w celu realizacji usług systemu CTRLABLE Node.
                </Text>
              </View>
              <Text style={styles.btnText}>Utwórz Przestrzeń Chmurową</Text>
              </TouchableOpacity>

              <TouchableOpacity style={{ marginTop: 20 }} onPress={() => setAuthStep('login')}>
                <Text style={{ color: '#64b5f6', fontSize: 13, fontWeight: 'bold', textAlign: 'center' }}>Powrót do logowania</Text>
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
  <ScrollView contentContainerStyle={styles.scrollWrapper}>
    <Text style={styles.screenHeaderText}>👥 Lista Użytkowników</Text>
    
    {/* 🌟 SEKCJA PAROWANIA PRZENIESIONA TUTAJ */}
    <View style={styles.card}>
      <Text style={styles.sectionHeader}>Dodawanie nowej karty</Text>
      {lockState.mode === 'Uczenie' ? (
        <Text style={styles.learningAlertText}>⚠️ Urządzenie oczekuje na zbliżenie fizycznego klucza RFID do czytnika...</Text>
      ) : (
        <TextInput style={styles.inputField} placeholder="Nazwa nowego profilu (np. Jan Kowalski)" placeholderTextColor="#555" value={newName} onChangeText={setNewName} />
      )}
      <TouchableOpacity 
        style={[styles.secondaryBtn, lockState.mode === 'Uczenie' ? { backgroundColor: '#cc3333' } : { backgroundColor: '#333' }]} 
        onPress={handleToggleLearn}
      >
        <Text style={styles.btnText}>{lockState.mode === 'Uczenie' ? '🛑 Wyłącz Wykrywanie Czytnika' : 'Uruchom Tryb Uczenia'}</Text>
      </TouchableOpacity>
    </View>

    {/* LISTA UŻYTKOWNIKÓW */}
    <View style={styles.card}>
      <Text style={styles.sectionHeader}>Zarejestrowane Karty ({lockState.total}/10)</Text>
              {lockState.users.map((user) => (
                <View key={user.idx} style={styles.userRow}>
                  <View style={{ flex: 1, paddingRight: 6 }}>
                    <Text style={styles.userName}>{user.name}</Text>
                  </View>
                  <View style={styles.rowActions}>
                    <TouchableOpacity style={{ padding: 4 }} onPress={() => promptUserRename(user.idx, user.name)}><Text style={{ color: '#64b5f6', marginRight: 16, fontWeight: 'bold', fontSize: 13 }}>✏️ Edytuj</Text></TouchableOpacity>
                    <TouchableOpacity onPress={() => executeCommand('/api/user/toggle_active', { idx: user.idx })}><Text style={{ color: user.active ? '#81c784' : '#ffb300', marginRight: 16, fontWeight: 'bold', fontSize: 13 }}>{user.active ? 'Aktywny' : 'Zamrożony'}</Text></TouchableOpacity>
                    <TouchableOpacity onPress={() => executeCommand('/api/user/delete', { idx: user.idx })}><Text style={{ color: '#e57373', fontWeight: 'bold', fontSize: 13 }}>❌ Usuń</Text></TouchableOpacity>
                  </View>
                </View>
              ))}
              {lockState.users.length === 0 ? <Text style={styles.subLabel}>Brak rekordów przypisanych do tego zamka.</Text> : null}
            </View>
          </ScrollView>
        )}

        {currentScreen === 'system' && (
          <ScrollView contentContainerStyle={styles.scrollWrapper}>
            <Text style={styles.screenHeaderText}>📋 Dziennik Zdarzeń (Real-Time)</Text>
            <View style={styles.card}>
              <ScrollView nestedScrollEnabled style={styles.internalLogBox}>{lockState.logs.map((log, index) => <Text key={index} style={styles.logText}>{log}</Text>)}</ScrollView>
            </View>
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
                  <Text style={styles.btnText}>✅ Jesteś na najnowszej wersji ({lockState.version})</Text>
                </TouchableOpacity>
              )}

              {otaState === 'available' && (
                <View style={{ marginTop: 8 }}>
                  <Text style={[styles.learningAlertText, { marginBottom: 16 }]}>🚀 Wykryto nowszą wersję oprogramowania {latestVersion || 'v2.9.5'}</Text>
                  <TouchableOpacity style={[styles.actionTriggerBtn, { backgroundColor: '#e11d48', marginTop: 0 }]} onPress={handleExecuteUpdate}>
                    <Text style={styles.btnText}>Zaktualizuj oprogramowanie</Text>
                  </TouchableOpacity>
                </View>
              )}

              {otaState === 'downloading_server' && (
                <TouchableOpacity style={[styles.actionTriggerBtn, { backgroundColor: '#f59e0b' }]} disabled>
                  <Text style={styles.btnText}>📥 Pobieranie paczki {latestVersion || 'v2.9.5'} na serwer...</Text>
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
      </View>
    </SafeAreaView>
);}

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