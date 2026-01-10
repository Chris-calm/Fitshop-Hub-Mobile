/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  AppStateStatus,
  Alert,
  Linking,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WebView } from 'react-native-webview';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import {
  getGrantedPermissions,
  getSdkStatus,
  initialize,
  readRecords,
  requestPermission,
} from 'react-native-health-connect';

const SITE_URL = 'https://fitshop-hub.vercel.app';
const LATEST_URL = 'https://fitshop-hub.vercel.app/assets/apk/latest.json';
const TOKEN_CREATE_URL = 'https://fitshop-hub.vercel.app/index.php?page=api_token_create';
const STEPS_SAVE_URL = 'https://fitshop-hub.vercel.app/index.php?page=api_steps_save';
const FOOD_SCAN_URL = 'https://fitshop-hub.vercel.app/index.php?page=food_scan';

// Keep this in sync with android/app/build.gradle (versionCode)
const APP_VERSION_CODE = 1;

function App() {
  const webRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [webUrl, setWebUrl] = useState(SITE_URL);
  const tokenRef = useRef<string>('');
  const healthConnectReadyRef = useRef(false);
  const permissionGrantedRef = useRef(false);
  const syncingRef = useRef(false);
  const lastSentRef = useRef<{ dateKey: string; steps: number } | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  const userAgent = useMemo(() => {
    const base = Platform.OS === 'android' ? 'Android' : Platform.OS;
    return `FitshopHubMobile/${APP_VERSION_CODE} (${base})`;
  }, []);

  const showTopBar = false;

  const goToFoodScan = useCallback(() => {
    setWebUrl(FOOD_SCAN_URL);
  }, []);

  const injectedAutoTokenJs = useMemo(() => {
    // Runs inside the WebView page context. Attempts to create a token using the current web session.
    // If user is not logged in, server returns 401 and we just ignore.
    return `
      (function(){
        try {
          if (!window.ReactNativeWebView || !window.fetch) return;
          var url = ${JSON.stringify(TOKEN_CREATE_URL)};
          var body = new URLSearchParams({ name: 'Android Step Sync' }).toString();
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body,
            credentials: 'include'
          })
          .then(function(r){ return r.json().catch(function(){ return null; }).then(function(j){ return { ok:r.ok, json:j }; }); })
          .then(function(res){
            if (!res || !res.ok || !res.json || !res.json.ok || !res.json.token) return;
            window.ReactNativeWebView.postMessage(JSON.stringify({ type:'FH_TOKEN', token: String(res.json.token) }));
          })
          .catch(function(){});
        } catch (e) {}
      })();
      true;
    `;
  }, []);

  const checkForUpdates = useCallback(async () => {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const url = `${LATEST_URL}${LATEST_URL.includes('?') ? '&' : '?'}t=${Date.now()}`;
      const resp = await fetch(url, {
        headers: {
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
      });
      if (!resp.ok) {
        throw new Error('Unable to check updates right now.');
      }
      const data = await resp.json();
      const latestCode = Number(data?.versionCode ?? 0);
      const apkUrl = String(data?.apkUrl ?? '');
      const notes = String(data?.releaseNotes ?? '');

      if (!latestCode || !apkUrl) {
        throw new Error('Update info is invalid.');
      }

      if (latestCode <= APP_VERSION_CODE) {
        Alert.alert('Up to date', 'You already have the latest version.');
        return;
      }

      Alert.alert(
        'Update available',
        `${notes ? notes + '\n\n' : ''}Open download page?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Download',
            onPress: async () => {
              const ok = await Linking.canOpenURL(apkUrl);
              if (!ok) {
                Alert.alert('Error', 'Cannot open download link.');
                return;
              }
              await Linking.openURL(apkUrl);
            },
          },
        ],
      );
    } catch (e: any) {
      Alert.alert('Update check failed', String(e?.message ?? e));
    } finally {
      setCheckingUpdate(false);
    }
  }, [checkingUpdate]);

  const postSyncingState = useCallback(async (syncing: boolean) => {
    if (!tokenRef.current) return;
    try {
      await fetch(STEPS_SAVE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenRef.current}`,
        },
        body: JSON.stringify({ syncing: syncing ? 1 : 0 }),
      });
    } catch {
      // ignore
    }
  }, []);

  const ensureHealthConnectReady = useCallback(async () => {
    if (Platform.OS !== 'android') return false;
    if (healthConnectReadyRef.current) return true;

    const status = await getSdkStatus();
    if (status !== 3) {
      return false;
    }
    const ok = await initialize();
    healthConnectReadyRef.current = !!ok;
    return healthConnectReadyRef.current;
  }, []);

  const ensureStepsPermission = useCallback(async () => {
    if (Platform.OS !== 'android') return false;
    if (permissionGrantedRef.current) return true;

    const granted = await getGrantedPermissions();
    const hasSteps = Array.isArray(granted)
      ? granted.some((p: any) => p && p.accessType === 'read' && p.recordType === 'Steps')
      : false;

    if (hasSteps) {
      permissionGrantedRef.current = true;
      return true;
    }

    const requested = await requestPermission([{ accessType: 'read', recordType: 'Steps' } as any]);
    const nowHasSteps = Array.isArray(requested)
      ? requested.some((p: any) => p && p.accessType === 'read' && p.recordType === 'Steps')
      : false;

    permissionGrantedRef.current = nowHasSteps;
    return permissionGrantedRef.current;
  }, []);

  const getTodayRange = useCallback(() => {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { startTime: start.toISOString(), endTime: now.toISOString() };
  }, []);

  const getLocalDateKey = useCallback(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }, []);

  const fetchTodaysSteps = useCallback(async () => {
    const { startTime, endTime } = getTodayRange();
    const res: any = await readRecords('Steps' as any, {
      timeRangeFilter: {
        operator: 'between',
        startTime,
        endTime,
      },
      ascendingOrder: false,
      pageSize: 5000,
    } as any);

    const records = Array.isArray(res?.records) ? res.records : [];
    const total = records.reduce((sum: number, r: any) => sum + Number(r?.count ?? 0), 0);
    return Math.max(0, Math.floor(total));
  }, [getTodayRange]);

  const syncStepsOnce = useCallback(async () => {
    if (Platform.OS !== 'android') return;
    if (syncingRef.current) return;
    if (!tokenRef.current) {
      return;
    }
    if (appStateRef.current !== 'active') return;

    const dateKey = getLocalDateKey();

    syncingRef.current = true;
    try {
      await postSyncingState(true);

      const ready = await ensureHealthConnectReady();
      if (!ready) {
        return;
      }

      const hasPerm = await ensureStepsPermission();
      if (!hasPerm) {
        return;
      }

      const steps = await fetchTodaysSteps();
      const last = lastSentRef.current;
      const alreadySentToday = last && last.dateKey === dateKey;
      if (alreadySentToday && steps <= last.steps) return;

      const resp = await fetch(STEPS_SAVE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenRef.current}`,
        },
        body: JSON.stringify({ steps, force: 0, syncing: 0 }),
      });
      if (resp.ok) {
        lastSentRef.current = { dateKey, steps };
      }
    } catch (e) {
      console.log('[FH] Step sync error', String((e as any)?.message ?? e));
    } finally {
      await postSyncingState(false);
      syncingRef.current = false;
    }
  }, [ensureHealthConnectReady, ensureStepsPermission, fetchTodaysSteps, getLocalDateKey, postSyncingState]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;

    const sub = AppState.addEventListener('change', (next) => {
      appStateRef.current = next;
      if (next === 'active') {
        void syncStepsOnce();
      }
    });

    intervalRef.current = setInterval(() => {
      void syncStepsOnce();
    }, 5 * 60 * 1000);

    void syncStepsOnce();

    return () => {
      sub.remove();
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [syncStepsOnce]);

  useEffect(() => {
    let alive = true;

    (async () => {
      const stored = await AsyncStorage.getItem('fh_api_token').catch(() => null);
      if (!alive) return;
      if (stored) {
        tokenRef.current = stored;
        if (Platform.OS === 'android') {
          void syncStepsOnce();
        }
      } else {
      }
    })();

    return () => {
      alive = false;
    };
  }, [syncStepsOnce]);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" />
        {showTopBar ? (
          <View style={styles.topbar}>
            <Text style={styles.brand}>Fitshop Hub</Text>
            <View style={styles.topActions}>
              <Pressable
                onPress={() => webRef.current?.reload()}
                style={({ pressed }) => [styles.actionBtn, pressed && styles.actionBtnPressed]}
              >
                <Text style={styles.actionText}>Reload</Text>
              </Pressable>
              <Pressable
                onPress={checkForUpdates}
                disabled={checkingUpdate}
                style={({ pressed }) => [
                  styles.actionBtn,
                  pressed && styles.actionBtnPressed,
                  checkingUpdate && styles.actionBtnDisabled,
                ]}
              >
                <Text style={styles.actionText}>{checkingUpdate ? 'Checking…' : 'Check updates'}</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        <View style={styles.webWrap}>
          <WebView
            ref={webRef}
            source={{ uri: webUrl }}
            onLoadStart={() => setLoading(true)}
            onLoadEnd={() => setLoading(false)}
            userAgent={userAgent}
            javaScriptEnabled
            domStorageEnabled
            injectedJavaScript={injectedAutoTokenJs}
            onMessage={async (ev) => {
              try {
                const payload = JSON.parse(String(ev.nativeEvent.data || '{}'));
                if (payload && payload.type === 'FH_TOKEN' && payload.token) {
                  const token = String(payload.token);
                  tokenRef.current = token;
                  await AsyncStorage.setItem('fh_api_token', token);
                  if (Platform.OS === 'android') {
                    void syncStepsOnce();
                  }
                }
              } catch {
                // ignore
              }
            }}
            allowsBackForwardNavigationGestures
            setSupportMultipleWindows={false}
          />

          <Pressable
            onPress={goToFoodScan}
            style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
          >
            <Text style={styles.fabText}>Food Scan</Text>
          </Pressable>

          {loading ? (
            <View style={styles.loading}>
              <ActivityIndicator size="large" color="#6366F1" />
            </View>
          ) : null}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#000',
  },
  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#0b0b0b',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#222',
  },
  brand: {
    color: '#e5e7eb',
    fontSize: 16,
    fontWeight: '700',
  },
  topActions: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: '#141414',
    borderWidth: 1,
    borderColor: '#262626',
  },
  actionBtnPressed: {
    opacity: 0.85,
  },
  actionBtnDisabled: {
    opacity: 0.6,
  },
  actionText: {
    color: '#e5e7eb',
    fontSize: 12,
    fontWeight: '600',
  },
  webWrap: {
    flex: 1,
  },
  syncBar: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#0b0b0b',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#222',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  syncText: {
    color: '#9ca3af',
    fontSize: 12,
  },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  fab: {
    position: 'absolute',
    right: 14,
    bottom: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: '#6366F1',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  fabPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.98 }],
  },
  fabText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
});

export default App;
