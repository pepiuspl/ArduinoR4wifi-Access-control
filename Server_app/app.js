import React, { useState, useEffect, useRef, useCallback } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, TextInput, ScrollView, SafeAreaView, Alert, Animated, Dimensions } from 'react-native';
import * as Haptics from 'expo-haptics';

const { width } = Dimensions.get('window');

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
  let [backendUrl, setBackendUrl] = useState('http://192.168.0.200:3000'); 
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accountId, setAccountId] = useState(null);
  const [isConfigured, setIsConfigured] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isRegisterMode, setIsRegisterMode] = useState(false); 
  const [isForgotPasswordMode, setIsForgotPasswordMode] = useState(false);
  
  // 🔐 STANY OBSŁUGI BEZPIECZNEGO RESETU HASŁA (OPCJA B)
  const [resetStep, setResetStep] = useState(1); // 1: Email, 2: Kod, 3: Nowe Hasło
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');

  // 💾 STAN OBSŁUGI AKTUALIZACJI OTA
  const [otaState, setOtaState] = useState('idle'); 
  const [latestVersion, setLatestVersion] = useState('');

  const [lockState, setLockState] = useState({ 
    auth: false, 
    account: { email: '-' },
    mode: '-', 
    lock: false, 
    total: 0, 
    users: [], 
    logs: [],
    ssid: 'Ecosystem LAN',
    version: '2.9.4' 
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
  const [settingsAdminPass, setSettingsAdminPass] = useState('');

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
    if (settingsAdminPass) {
      fetch(`${backendUrl}/api/settings/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, newPassword: settingsAdminPass })
      })
        .then(() => Alert.alert("Zapisano", "Master password zaktualizowane na zamku."))
        .catch(() => alert("Błąd synchronizacji hasła z hardware."));
    }
    if (settingsSsid) {
      fetch(`${backendUrl}/api/settings/wifi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, wifiSSID: settingsSsid, wifiPass: settingsWifiPass })
      })
        .then(() => Alert.alert("Zapisano", "Nowe profile Wi-Fi wysłane. Zamek się restartuje."))
        .catch(() => alert("Błąd synchronizacji Wi-Fi z hardware."));
    }
    setSettingsWifiPass('');
    setSettingsAdminPass('');
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
        const currentVer = (lockState.version || '0.0.0').replace('v', '').trim();
        const latestVer = data.latestVersion.replace('v', '').trim();
        
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

  const fetchStatus = useCallback(() => {
    if (!isConfigured || !accountId) return;
    fetch(`${backendUrl}/api/data?accountId=${accountId}`)
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then((data) => {
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
        setErrorMessage(`Handshaking connection lines with Proxmox nodes...`);
      });
  }, [isConfigured, accountId, backendUrl]);

  const executeCommand = (endpoint, payload = null) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const method = payload ? 'POST' : 'GET';
    const config = {
      method: method,
      headers: payload ? { 'Content-Type': 'application/json' } : {}
    };
    if (payload) config.body = JSON.stringify({ ...payload, accountId });

    const separator = endpoint.includes('?') ? '&' : '?';
    fetch(`${backendUrl}${endpoint}${payload ? '' : separator + 'accountId=' + accountId}`, config)
      .then(() => {
        fetchStatus();
      })
      .catch((error) => setErrorMessage(`Transaction failure: ${error.message}`));
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
      "Wprowadź nową etykietę dla lokatora " + currentName + ":",
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
      }
    };
    bootstrapAsyncState();
  }, [backendUrl, resetUiToDefault]); 

  useEffect(() => {
    if (!isConfigured || !accountId) return;
    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, [isConfigured, accountId, fetchStatus]);

  if (!isConfigured) {
    return (
      <SafeAreaView style={styles.darkContainer}>
        <View style={styles.authCard}>
          <TouchableOpacity activeOpacity={0.8} onPress={handleLogoTap}>
            <Text style={styles.lockIconSymbol}>🔒</Text>
          </TouchableOpacity>
          <Text style={styles.titleText}>
            {isForgotPasswordMode ? `Odzyskiwanie [Krok ${resetStep}/3]` : isRegisterMode ? 'Rejestracja CTRLABLE' : 'CTRLABLE Portal'}
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

          {/* DYNAMICZNE RENDEROWANIE POLA RESETU LUB PANELU LOGOWANIA */}
          {isForgotPasswordMode ? (
            <>
              {resetStep === 1 && (
                <>
                  <Text style={styles.inputLabelText}>Adres E-mail konta do zresetowania:</Text>
                  <TextInput style={styles.inputField} placeholder="nazwa@domena.pl" keyboardType="email-address" autoCapitalize="none" placeholderTextColor="#444" editable={!isAuthenticating} value={email} onChangeText={setEmail} />
                  <TouchableOpacity style={[styles.primaryBtn, isAuthenticating ? {backgroundColor: '#333'} : null]} onPress={handleForgotPasswordSubmit} disabled={isAuthenticating}>
                    <Text style={styles.btnText}>Wyślij Kod Autoryzacyjny</Text>
                  </TouchableOpacity>
                </>
              )}
              {resetStep === 2 && (
                <>
                  <Text style={styles.inputLabelText}>Wprowadź 6-cyfrowy kod z wiadomości:</Text>
                  <TextInput style={styles.inputField} placeholder="np. 482910" keyboardType="number-pad" autoCapitalize="none" maxLength={6} placeholderTextColor="#444" editable={!isAuthenticating} value={resetCode} onChangeText={setResetCode} />
                  <TouchableOpacity style={[styles.primaryBtn, isAuthenticating ? {backgroundColor: '#333'} : null]} onPress={handleVerifyResetCode} disabled={isAuthenticating}>
                    <Text style={styles.btnText}>Zweryfikuj Token</Text>
                  </TouchableOpacity>
                </>
              )}
              {resetStep === 3 && (
                <>
                  <Text style={styles.inputLabelText}>Nowe Hasło Master:</Text>
                  <TextInput style={styles.inputField} placeholder="••••••••" placeholderTextColor="#444" secureTextEntry editable={!isAuthenticating} value={newPassword} onChangeText={setNewPassword} />
                  <Text style={styles.inputLabelText}>Powtórz Nowe Hasło:</Text>
                  <TextInput style={styles.inputField} placeholder="••••••••" placeholderTextColor="#444" secureTextEntry editable={!isAuthenticating} value={confirmNewPassword} onChangeText={setConfirmNewPassword} />
                  <TouchableOpacity style={[styles.primaryBtn, isAuthenticating ? {backgroundColor: '#333'} : null]} onPress={handleConfirmPasswordReset} disabled={isAuthenticating}>
                    <Text style={styles.btnText}>Zapisz Nowy Klucz i Zakończ</Text>
                  </TouchableOpacity>
                </>
              )}
            </>
          ) : (
            <>
              <Text style={styles.inputLabelText}>Adres E-mail:</Text>
              <TextInput style={styles.inputField} placeholder="nazwa@domena.pl" keyboardType="email-address" autoCapitalize="none" placeholderTextColor="#444" editable={!isAuthenticating} value={email} onChangeText={setEmail} />
              
              <Text style={styles.inputLabelText}>Klucz Bezpieczeństwa (Hasło):</Text>
              <TextInput style={styles.inputField} placeholder="••••••••" placeholderTextColor="#444" secureTextEntry editable={!isAuthenticating} value={password} onChangeText={setPassword} />
              
              <TouchableOpacity style={[styles.primaryBtn, isAuthenticating ? {backgroundColor: '#333'} : null]} onPress={isRegisterMode ? handleAccountRegistration : handleSecurityLogin} disabled={isAuthenticating}>
                <Text style={styles.btnText}>{isAuthenticating ? 'Przetwarzanie żądania...' : isRegisterMode ? 'Utwórz Przestrzeń Chmurową' : 'Zaloguj się'}</Text>
              </TouchableOpacity>
            </>
          )}

          <TouchableOpacity style={{ marginTop: 20 }} onPress={() => { setIsForgotPasswordMode(!isForgotPasswordMode); setResetStep(1); setIsRegisterMode(false); }}>
            <Text style={{ color: '#64b5f6', fontWeight: 'bold', fontSize: 13, textAlign: 'center' }}>
              {isForgotPasswordMode ? 'Powrót do ekranu logowania' : 'Zapomniałeś hasła? Bezpieczny reset przez e-mail'}
            </Text>
          </TouchableOpacity>

          {!isForgotPasswordMode && (
            <TouchableOpacity style={{ marginTop: 14 }} onPress={() => setIsRegisterMode(!isRegisterMode)}>
              <Text style={{ color: '#aaa', fontSize: 13, textAlign: 'center' }}>
                {isRegisterMode ? 'Masz już profil? Zaloguj się' : 'Chcesz dodać przestrzeń? Zarejestruj się'}
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
          <View style={styles.burgerStripeLine} /><View style={[styles.burgerStripeLine, { marginVertical: 5 }]} /><View style={styles.burgerStripeLine} />
        </TouchableOpacity>
        <Text style={styles.headerTitleText}>CTRLABLE Gateway</Text>
        <View style={{ width: 24 }} />
      </View>

      <View style={{ flex: 1 }}>
        {currentScreen === 'dashboard' && (
          <ScrollView contentContainerStyle={styles.scrollWrapper}>
            <Text style={styles.screenHeaderText}>📱 Pokój Kontrolny</Text>
            {errorMessage ? <View style={styles.errorCard}><Text style={styles.errorTextInsideCard}>⚠️ {errorMessage}</Text></View> : null}
            <View style={styles.statusBox}>
              <Text style={styles.label}>Stan Rygla Elektromagnetycznego:</Text>
              <Text style={[styles.valueBold, { color: lockState.lock ? '#81c784' : '#e57373' }]}>{lockState.lock ? '🔓 OTWARTY / SYSTEM ZWOLNIONY' : '🔒 ZABEZPIECZONY / RYGIEL ZABLOKOWANY'}</Text>
              <Text style={styles.subLabel}>Bieżący tryb operacyjny hardware: {lockState.mode}</Text>
            </View>
            <TouchableOpacity style={[styles.actionTriggerBtn, { backgroundColor: lockState.lock ? '#cc3333' : '#2e7d32' }]} onPress={() => executeCommand('/api/unlock')}><Text style={styles.btnText}>{lockState.lock ? 'Zwalnianie impulsu...' : '⚡ Otwórz Drzwi Zdalnie'}</Text></TouchableOpacity>
            <View style={styles.card}>
              <Text style={styles.sectionHeader}>➕ Mapowanie Nowego Lokatora</Text>
              {lockState.mode === 'Uczenie' ? <Text style={styles.learningAlertText}>⚠️ Urządzenie oczekuje na zbliżenie fizycznego klucza RFID do czytnika...</Text> : <TextInput style={styles.inputField} placeholder="Nazwa nowego profilu (np. Jan Kowalski)" placeholderTextColor="#555" value={newName} onChangeText={setNewName} />}
              <TouchableOpacity style={[styles.secondaryBtn, lockState.mode === 'Uczenie' ? { backgroundColor: '#cc3333' } : { backgroundColor: '#333' }]} onPress={handleToggleLearn}><Text style={styles.btnText}>{lockState.mode === 'Uczenie' ? '🛑 Wyłącz Wykrywanie Czytnika' : 'Uruchom Tryb Parowania Klucza'}</Text></TouchableOpacity>
            </View>
          </ScrollView>
        )}

        {currentScreen === 'directory' && (
          <ScrollView contentContainerStyle={styles.scrollWrapper}>
            <Text style={styles.screenHeaderText}>👥 Wykaz Profilów Lokatorów</Text>
            <View style={styles.card}>
              <Text style={styles.sectionHeader}>Zarejestrowane Pozycje ({lockState.total}/10)</Text>
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
              {lockState.users.length === 0 ? <Text style={styles.subLabel}>Brak rekordów lokatorów przypisanych do tego zamka.</Text> : null}
            </View>
          </ScrollView>
        )}

        {currentScreen === 'system' && (
          <ScrollView contentContainerStyle={styles.scrollWrapper}>
            <Text style={styles.screenHeaderText}>📋 Dzienniki Zdarzeń Teletrycznych (Real-Time)</Text>
            <View style={styles.card}>
              <ScrollView nestedScrollEnabled style={styles.internalLogBox}>{lockState.logs.map((log, index) => <Text key={index} style={styles.logText}>{log}</Text>)}</ScrollView>
            </View>
          </ScrollView>
        )}

        {/* EKRAN AKTUALIZACJI OTA (Z POPRAWIONYM STANEM otaState) */}
        {currentScreen === 'ota' && (
          <ScrollView contentContainerStyle={styles.scrollWrapper}>
            <Text style={styles.screenHeaderText}>💾 Aktualizacja Firmware (OTA)</Text>
            
            <View style={styles.statusBox}>
              <Text style={styles.label}>Bieżąca wersja struktury zamka:</Text>
              <Text style={[styles.valueBold, { color: '#64b5f6' }]}>{lockState.version}</Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionHeader}>Weryfikacja wydań</Text>
              
              {otaState === 'idle' && (
                <TouchableOpacity style={[styles.actionTriggerBtn, { backgroundColor: '#3b82f6' }]} onPress={handleCheckUpdate}>
                  <Text style={styles.btnText}>🔍 Sprawdź dostępność aktualizacji</Text>
                </TouchableOpacity>
              )}

              {otaState === 'checking' && (
                <TouchableOpacity style={[styles.actionTriggerBtn, { backgroundColor: '#4b5563' }]} disabled>
                  <Text style={styles.btnText}>⏳ Sprawdzanie struktury wydań...</Text>
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
                  <TouchableOpacity style={[styles.actionTriggerBtn, { backgroundColor: '#e11d48', marginTop: 0 }]} onPress={() => executeCommand('/api/ota/push')}>
                    <Text style={styles.btnText}>Zaktualizuj oprogramowanie</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </ScrollView>
        )}

        {currentScreen === 'settings' && (
          <ScrollView contentContainerStyle={styles.scrollWrapper}>
            <Text style={styles.screenHeaderText}>⚙️ Konfiguracja Infrastruktury</Text>
            
            <View style={styles.card}>
              <Text style={styles.sectionHeader}>👤 Dane Profilu Administratora</Text>
              <Text style={[styles.inputLabelText, {color: '#81c784', fontSize: 15, fontWeight:'600'}]}>✓ {lockState.account ? lockState.account.email : email}</Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionHeader}>🔒 Zmiana Hasła Master Panelu (Hardware)</Text>
              <Text style={styles.inputLabelText}>Nowe Hasło Master Administratora (Zapis do EEPROM):</Text>
              <TextInput style={styles.inputField} secureTextEntry placeholder="Wprowadź nowe hasło master" placeholderTextColor="#555" value={settingsAdminPass} onChangeText={setSettingsAdminPass} />
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionHeader}>📶 Zmiana Konfiguracji Sieci Wi-Fi Zamka</Text>
              <Text style={styles.inputLabelText}>Identyfikator Sieci (SSID):</Text>
              <TextInput style={styles.inputField} placeholder="Nazwa nowej sieci Wi-Fi" placeholderTextColor="#555" value={settingsSsid} onChangeText={setSettingsSsid} />
              <Text style={styles.inputLabelText}>Hasło do Sieci:</Text>
              <TextInput style={styles.inputField} secureTextEntry placeholder="Hasło nowej sieci Wi-Fi" placeholderTextColor="#555" value={settingsWifiPass} onChangeText={setSettingsWifiPass} />
              
              <TouchableOpacity style={[styles.secondaryBtn, { backgroundColor: '#5c33cf', width: '100%', marginTop: 12 }]} onPress={handleSaveSystemSettings}>
                <Text style={styles.btnText}>💾 Wyślij Ustawienia i Zrestartuj Zamek</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        )}

        {isMenuOpen && <TouchableOpacity style={styles.menuDimBackdropMask} activeOpacity={1} onPress={toggleBurgerMenu} />}
        <Animated.View style={[styles.burgerSidebarDrawerContainer, { left: menuAnimation }]}>
          <View style={styles.sidebarBrandHeaderBox}><Text style={styles.sidebarBrandTitleText}>Nawigacja Modułów</Text></View>
          <TouchableOpacity style={[styles.menuItemRow, currentScreen === 'dashboard' ? styles.menuItemRowActive : null]} onPress={() => navigateTo('dashboard')}><Text style={styles.menuItemLabelText}>📱 Panel Główny</Text></TouchableOpacity>
          <TouchableOpacity style={[styles.menuItemRow, currentScreen === 'directory' ? styles.menuItemRowActive : null]} onPress={() => navigateTo('directory')}><Text style={styles.menuItemLabelText}>👥 Roster Lokatorów</Text></TouchableOpacity>
          <TouchableOpacity style={[styles.menuItemRow, currentScreen === 'system' ? styles.menuItemRowActive : null]} onPress={() => navigateTo('system')}><Text style={styles.menuItemLabelText}>📋 Logi Systemowe</Text></TouchableOpacity>
          <TouchableOpacity style={[styles.menuItemRow, currentScreen === 'ota' ? styles.menuItemRowActive : null]} onPress={() => navigateTo('ota')}><Text style={styles.menuItemLabelText}>💾 Aktualizacja OTA</Text></TouchableOpacity>
          <TouchableOpacity style={[styles.menuItemRow, currentScreen === 'settings' ? styles.menuItemRowActive : null]} onPress={() => navigateTo('settings')}><Text style={styles.menuItemLabelText}>⚙️ Ustawienia</Text></TouchableOpacity>
          <View style={{flex: 1}} />
          <TouchableOpacity style={styles.sidebarDisconnectBtn} onPress={async () => {
            await AsyncStorage.removeItem('@lock_account_id');
            menuAnimation.setValue(-width * 0.75);
            setIsMenuOpen(false);
            setCurrentScreen('dashboard');
            setIsConfigured(false);
          }}><Text style={styles.btnText}>Wyloguj Profil</Text></TouchableOpacity>
        </Animated.View>
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