import React, { useState, useEffect, useRef, useCallback } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, TextInput, ScrollView, SafeAreaView, Alert, Animated, Dimensions, KeyboardAvoidingView, Platform, Switch} from 'react-native';
import * as Haptics from 'expo-haptics';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';

const { width } = Dimensions.get('window');

// Powiadomienia Push

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// DECYDOWANIE O POWIADOMIENIACH PUSH

const [pushEntries, setPushEntries] = useState(true);
const [pushAlarms, setPushAlarms] = useState(true);

const savePushPreferences = (entries, alarms) => {
  fetch(`${backendUrl}/api/settings/push_preferences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId, pushEntries: entries, pushAlarms: alarms })
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    })
    .catch((err) => console.log("Błąd zapisu preferencji push:", err));
};

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

export default function App() {
  let [backendUrl, setBackendUrl] = useState('http://185.101.191.76:3000'); 
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accountId, setAccountId] = useState(null);
  const [isConfigured, setIsConfigured] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isRegisterMode, setIsRegisterMode] = useState(false); 
  const [isForgotPasswordMode, setIsForgotPasswordMode] = useState(false);
  
  // STANY OBSŁUGI BEZPIECZNEGO RESETU HASŁA (OPCJA B)
  const [resetStep, setResetStep] = useState(1); // 1: Email, 2: Kod, 3: Nowe Hasło
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
  const [isOnboardingNewDevice, setIsOnboardingNewDevice] = useState(false);

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
    const toValue = isMenuOpen ? -width * 0.75 : 0;
    Animated.timing(menuAnimation, {
      toValue: toValue,
      duration: 250,
      useNativeDriver: false,
    }).start();
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

  const handleAccountRegistration = () => {
    if (!email || !password) return;
    setIsAuthenticating(true);
    setErrorMessage('Registering structural access credentials...');

    fetch(`${backendUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password: password.trim() })
    })
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then((data) => {
        setLatestVersion(data.latestVersion);
        setIsAuthenticating(false);
        if (data.status === 'registered') {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Alert.alert('Account Provisioned', 'Registration successful!');
          setIsRegisterMode(false);
          setErrorMessage('');
        }
      })
      .catch(() => {
        setIsAuthenticating(false);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setErrorMessage('Registration Interrupted: Email conflicts or offline backend.');
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
        if (data.auth && data.accountId) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          await AsyncStorage.setItem('@lock_account_id', String(data.accountId));
          setAccountId(data.accountId);
          resetUiToDefault();
          setIsConfigured(true);
          setErrorMessage('');
          registerForPushNotificationsAsync(data.accountId);
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

  // 🔐 PIPELINE ODZYSKIWANIA HASŁA (3 KROKI)
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

            // Jeśli wersja w lockState zmieniła się na oczekiwaną - mamy sukces!
            if (lockState.version === latestVersion) {
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

  const fetchStatus = useCallback(() => {
    if (!isConfigured || !accountId) return;
    fetch(`${backendUrl}/api/data?accountId=${accountId}`)
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then((data) => {
        if (data.pushEntries !== undefined) setPushEntries(data.pushEntries);
        if (data.pushAlarms !== undefined) setPushAlarms(data.pushAlarms);
        if (data.auth === false) {
          setIsConfigured(false);
        } else {
          setLockState(prevState => ({
            ...data,
            version: data.version || prevState.version || '2.9.4'
          }));
          setErrorMessage('');
        }
      })
      .catch(() => {
        setErrorMessage(`Łączenie z serwerem...`);
      });
  }, [isConfigured, accountId, backendUrl]);

  const executeCommand = (endpoint, payload = null) => {
  // Wywołujemy Twoją haptykę (wibrację) natychmiast po dotknięciu
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

  if (endpoint === '/api/unlock') {
    setLockState(prevState => ({ ...prevState, lock: 'pending' }));
  }

  const method = payload ? 'POST' : 'GET';
  const config = {
    method: method,
    headers: payload ? { 'Content-Type': 'application/json' } : {}
  };
  if (payload) config.body = JSON.stringify({ ...payload, accountId });

  const separator = endpoint.includes('?') ? '&' : '?';
  
  fetch(`${backendUrl}${endpoint}${payload ? '' : separator + 'accountId=' + accountId}`, config)
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
  // Na emulatorach webowych Snacka Device.isDevice może być false, 
  // usuwamy twardą blokadę, abyś mógł przetestować to nawet w przeglądarce!
  
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
        const tokenData = await Notifications.getExpoPushTokenAsync();
        token = tokenData.data;
      } catch (e) {
        // Awaria piaskownicy Snack (brak projectId) -> przechodzimy do symulacji
        token = `ExponentPushToken[SnackSimulated_${targetAccountId}]`;
      }
    } else {
        // Brak uprawnień lub web/emulator -> wymuszamy token symulacyjny
        token = `ExponentPushToken[SnackSimulated_${targetAccountId}]`;
      }

      // Wysyłamy token bezpośrednio na Twój serwer Proxmox
      const response = await fetch(`${backendUrl}/api/auth/save_push_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: targetAccountId, token })
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
      const storedUrl = await AsyncStorage.getItem('@lock_backend_endpoint');
      if (storedUrl) {
        setBackendUrl(storedUrl);
        setInstallerUrlInput(storedUrl);
      } else {
        setInstallerUrlInput(backendUrl);
      }
      const storedAccountId = await AsyncStorage.getItem('@lock_account_id');
      if (storedAccountId) {
        setAccountId(parseInt(storedAccountId, 10));
        resetUiToDefault();
        setIsConfigured(true);
        registerForPushNotificationsAsync(parseInt(storedAccountId, 10));
      }
    };
    bootstrapAsyncState();
  }, [backendUrl, resetUiToDefault]); 

  useEffect(() => {
  if (!isConfigured || !accountId) return;

  fetchStatus(); // Pobierz stan od razu
  
  const dynamicIntervalTime = (lockState.lock === true || lockState.lock === 'pending') ? 500 : 3000;
  
  const interval = setInterval(fetchStatus, dynamicIntervalTime);
  return () => clearInterval(interval);
}, [isConfigured, accountId, fetchStatus, lockState.lock]);

  if (!isConfigured) {
    return (
      <SafeAreaView style={styles.darkContainer}>
        <View style={styles.authCard}>
          <TouchableOpacity activeOpacity={0.8} onPress={handleLogoTap}>
            <Text style={styles.lockIconSymbol}>🔒</Text>
          </TouchableOpacity>
          <Text style={styles.titleText}>
            {isOnboardingNewDevice ? 'Inicjalizacja Węzła' : isForgotPasswordMode ? `Odzyskiwanie [Krok ${resetStep}/3]` : isRegisterMode ? 'Rejestracja CTRLABLE' : 'CTRLABLE Portal'}
          </Text>
          
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

          {/* DYNAMICZNE RENDEROWANIE KREATORA NOWEGO URZĄDZENIA, POLA RESETU LUB PANELU LOGOWANIA */}
          {isOnboardingNewDevice ? (
            <>
              <Text style={[styles.inputLabelText, { textAlign: 'center', marginBottom: 20, alignSelf: 'center' }]}>
                1. Wejdź w ustawienia Wi-Fi swojego telefonu.{"\n"}
                2. Połącz się z siecią: CTRLABLE_SETUP{"\n"}
                3. Wróć tutaj i uzupełnij konfigurację:
              </Text>

              <Text style={styles.inputLabelText}>Nazwa sieci Wi-Fi centralki (SSID):</Text>
              <TextInput style={styles.inputField} placeholder="Wpisz nazwę sieci Wi-Fi" placeholderTextColor="#444" value={settingsSsid} onChangeText={setSettingsSsid} />
              
              <Text style={styles.inputLabelText}>Hasło do sieci Wi-Fi:</Text>
              <TextInput style={styles.inputField} placeholder="Wpisz hasło Wi-Fi" placeholderTextColor="#444" secureTextEntry value={settingsWifiPass} onChangeText={setSettingsWifiPass} />

              <Text style={[styles.sectionHeader, { marginTop: 10 }]}>Tworzenie konta</Text>
              <Text style={styles.inputLabelText}>Adres E-mail:</Text>
              <TextInput style={styles.inputField} placeholder="nazwa@domena.pl" keyboardType="email-address" autoCapitalize="none" placeholderTextColor="#444" value={email} onChangeText={setEmail} />
              
              <Text style={styles.inputLabelText}>Hasło:</Text>
              <TextInput style={styles.inputField} placeholder="••••••••" placeholderTextColor="#444" secureTextEntry value={password} onChangeText={setPassword} />

              <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: '#2e7d32' }]} onPress={() => {
                fetch(`http://192.168.4.1/save_setup?s=${encodeURIComponent(settingsSsid)}&p=${encodeURIComponent(settingsWifiPass)}&m=${encodeURIComponent(email)}&reg_pass=${encodeURIComponent(password)}&offline=0`)
                  .then(() => {
                    Alert.alert("Sukces!", "Centralka odebrała dane i konfiguruje system. Zaloguj się teraz.");
                    setIsOnboardingNewDevice(false);
                  })
                  .catch(() => Alert.alert("Błąd", "Nie można połączyć się z centralką. Czy na pewno jesteś w sieci CTRLABLE_SETUP?"));
              }}>
                <Text style={styles.btnText}>Zapisz i Utwórz Konto</Text>
              </TouchableOpacity>

              <TouchableOpacity style={{ marginTop: 20 }} onPress={() => setIsOnboardingNewDevice(false)}>
                <Text style={{ color: '#64b5f6', fontWeight: 'bold', fontSize: 13, textAlign: 'center' }}>Powrót do ekranu logowania</Text>
              </TouchableOpacity>
            </>
          ) : isForgotPasswordMode ? (
            <>
              {resetStep === 1 && (
                <>
                  <Text style={styles.inputLabelText}>Adres E-mail:</Text>
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
                  <View style={{ width: '100%', position: 'relative' }}>
                    <TextInput style={styles.inputField} placeholder="••••••••" placeholderTextColor="#444" secureTextEntry={secureReset} editable={!isAuthenticating} value={newPassword} onChangeText={setNewPassword} />
                    <TouchableOpacity style={{ position: 'absolute', right: 14, top: 16 }} onPress={() => setSecureReset(!secureReset)}>
                      <Text style={{ color: '#64b5f6', fontWeight: 'bold' }}>{secureReset ? "Pokaż" : "Ukryj"}</Text>
                    </TouchableOpacity>
                  </View>

                  <Text style={styles.inputLabelText}>Powtórz Nowe Hasło:</Text>
                  <View style={{ width: '100%', position: 'relative' }}>
                    <TextInput style={styles.inputField} placeholder="••••••••" placeholderTextColor="#444" secureTextEntry={secureReset} editable={!isAuthenticating} value={confirmNewPassword} onChangeText={setConfirmNewPassword} />
                  </View>

                  <TouchableOpacity style={[styles.primaryBtn, isAuthenticating ? {backgroundColor: '#333'} : null]} onPress={handleConfirmPasswordReset} disabled={isAuthenticating}>
                    <Text style={styles.btnText}>Zapisz Ustawienia i Zakończ</Text>
                  </TouchableOpacity>
                </>
              )}
            </>
          ) : (
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
              
              <TouchableOpacity style={[styles.primaryBtn, isAuthenticating ? {backgroundColor: '#333'} : null]} onPress={isRegisterMode ? handleAccountRegistration : handleSecurityLogin} disabled={isAuthenticating}>
                <Text style={styles.btnText}>{isAuthenticating ? 'Przetwarzanie żądania...' : isRegisterMode ? 'Utwórz Przestrzeń Chmurową' : 'Zaloguj się'}</Text>
              </TouchableOpacity>

              {/* RESTRYKCJA: PRZYCISK WIDOCZNY TYLKO W TRYBIE CZUWANIA/LOGOWANIA */}
              {!isRegisterMode && (
                <TouchableOpacity style={{ marginTop: 14, padding: 14, borderWidth: 1, borderColor: '#5c33cf', borderRadius: 10, width: '100%' }} onPress={() => setIsOnboardingNewDevice(true)}>
                  <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 14, textAlign: 'center' }}>Skonfiguruj nową centralkę</Text>
                </TouchableOpacity>
              )}
            </>
          )}

          <TouchableOpacity style={{ marginTop: 20 }} onPress={() => { setIsForgotPasswordMode(!isForgotPasswordMode); setResetStep(1); setIsRegisterMode(false); setIsOnboardingNewDevice(false); }}>
            <Text style={{ color: '#64b5f6', fontWeight: 'bold', fontSize: 13, textAlign: 'center' }}>
              {isForgotPasswordMode ? 'Powrót do ekranu logowania' : 'Zapomniałeś hasła? Zrestartuj je przez e-mail'}
            </Text>
          </TouchableOpacity>

          {!isForgotPasswordMode && !isOnboardingNewDevice && (
            <TouchableOpacity style={{ marginTop: 14 }} onPress={() => setIsRegisterMode(!isRegisterMode)}>
              <Text style={{ color: '#aaa', fontSize: 13, textAlign: 'center' }}>
                {isRegisterMode ? 'Masz już profil? Zaloguj się' : 'Nie masz jeszcze konta? Zarejestruj się'}
              </Text>
            </TouchableOpacity>
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
        <Text style={styles.headerTitleText}>CTRLABLE NODE
        </Text>
        <View style={{ width: 24 }} />
        </View>

      
        <View style={{ flex: 1 }}>
          {currentScreen === 'dashboard' && (
            <ScrollView contentContainerStyle={styles.scrollWrapper}>
              <Text style={styles.screenHeaderText}>📱 Dashboard</Text>
              {errorMessage ? <View style={styles.errorCard}><Text style={styles.errorTextInsideCard}>⚠️ {errorMessage}</Text></View> : null}
              <View style={styles.statusBox}>
                <Text style={styles.label}>Stan Zamka:</Text>
      
                {/*Dynamiczne kolory dla 3 stanów automatyki */}
                <Text style={[styles.valueBold, { 
                color: lockState.lock === true ? '#81c784' : lockState.lock === 'pending' ? '#ffb74d' : '#e57373' 
                }]}>
                {lockState.lock === true && '🔓 OTWARTY / SYSTEM ZWOLNIONY'}
                {lockState.lock === 'pending' && '⚡ WYWOŁYWANIE SYGNAŁU...'}
                {lockState.lock === false && '🔒 ZABEZPIECZONY / RYGIEL ZABLOKOWANY'}
                </Text>
      
                <Text style={styles.subLabel}>Bieżący tryb operacyjny: {lockState.mode}</Text>
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
                <TouchableOpacity style={[styles.actionTriggerBtn, { backgroundColor: '#4b5563' }]} disabled>
                  <Text style={styles.btnText}>⏳ Sprawdzanie dostępności aktualizacji...</Text>
                </TouchableOpacity>
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
              
              <View style={styles.card}>
                <Text style={styles.sectionHeader}>👤 Dane Profilu</Text>
                <Text style={[styles.inputLabelText, {color: '#81c784', fontSize: 15, fontWeight:'600'}]}>✓ {lockState.account ? lockState.account.email : email}</Text>
              </View>

              {/* FORMULARZ: ZMIANA HASŁA APLIKACJI */}
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

              {/* FORMULARZ: ZMIANA HASŁA WI-FI ZAMKA */}
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
            </ScrollView>
          </KeyboardAvoidingView>
        )}
        

        {isMenuOpen && <TouchableOpacity style={styles.menuDimBackdropMask} activeOpacity={1} onPress={toggleBurgerMenu} />}
        <Animated.View style={[styles.burgerSidebarDrawerContainer, { left: menuAnimation }]}>
          <View style={styles.sidebarBrandHeaderBox}><Text style={styles.sidebarBrandTitleText}>Nawigacja</Text></View>
          <TouchableOpacity style={[styles.menuItemRow, currentScreen === 'dashboard' ? styles.menuItemRowActive : null]} onPress={() => navigateTo('dashboard')}><Text style={styles.menuItemLabelText}>📱 Dashboard</Text></TouchableOpacity>
          <TouchableOpacity style={[styles.menuItemRow, currentScreen === 'directory' ? styles.menuItemRowActive : null]} onPress={() => navigateTo('directory')}><Text style={styles.menuItemLabelText}>👥 Lista Użytkowników</Text></TouchableOpacity>
          <TouchableOpacity style={[styles.menuItemRow, currentScreen === 'notifications' ? styles.menuItemRowActive : null]} onPress={() => navigateTo('notifications')}><Text style={styles.menuItemLabelText}>🔔 Powiadomienia Push</Text></TouchableOpacity>
          <TouchableOpacity style={[styles.menuItemRow, currentScreen === 'system' ? styles.menuItemRowActive : null]} onPress={() => navigateTo('system')}><Text style={styles.menuItemLabelText}>📋 Logi Systemowe</Text></TouchableOpacity>
          <TouchableOpacity style={[styles.menuItemRow, currentScreen === 'ota' ? styles.menuItemRowActive : null]} onPress={() => navigateTo('ota')}><Text style={styles.menuItemLabelText}>💾 Aktualizacja</Text></TouchableOpacity>
          <TouchableOpacity style={[styles.menuItemRow, currentScreen === 'settings' ? styles.menuItemRowActive : null]} onPress={() => navigateTo('settings')}><Text style={styles.menuItemLabelText}>⚙️ Ustawienia</Text></TouchableOpacity>
          <View style={{flex: 1}} />
          <TouchableOpacity style={styles.sidebarDisconnectBtn} onPress={async () => {
            await AsyncStorage.removeItem('@lock_account_id');
            menuAnimation.setValue(-width * 0.75);
            setIsMenuOpen(false);
            setCurrentScreen('dashboard');
            setIsConfigured(false);
            setCurrentScreen('dashboard');
          }}><Text style={styles.btnText}>Wyloguj się</Text></TouchableOpacity>
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
  scrollWrapper: { padding: 16, paddingBottom: 40 },
  screenHeaderText: { fontSize: 20, fontWeight: 'bold', color: '#fff', marginBottom: 16, letterSpacing: 0.3 },
  authCard: { padding: 24, backgroundColor: '#16161a', borderRadius: 16, marginTop: 40, marginHorizontal: 8, alignItems: 'center', borderWidth: 1, borderColor: '#222' },
  lockIconSymbol: { fontSize: 54, marginBottom: 12 },
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
  sidebarBrandHeaderBox: { paddingVertical: 20, borderBottomWidth: 1, borderBottomColor: '#222', marginBottom: 20 },
  sidebarBrandTitleText: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  menuItemRow: { paddingVertical: 16, paddingHorizontal: 12, borderRadius: 8, marginBottom: 8 },
  menuItemRowActive: { backgroundColor: '#202026' },
  menuItemLabelText: { color: '#ccc', fontSize: 16, fontWeight: '600' },
  sidebarDisconnectBtn: { backgroundColor: '#1e1b1b', padding: 14, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: '#3f1a1a' }
});