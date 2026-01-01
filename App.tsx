/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  InteractionManager,
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
import { initialize, readRecords } from 'react-native-health-connect';

const SITE_URL = 'https://fitshop-hub.vercel.app';
const LATEST_URL = 'https://fitshop-hub.vercel.app/assets/apk/latest.json';
const TOKEN_CREATE_URL = 'https://fitshop-hub.vercel.app/index.php?page=api_token_create';
const STEPS_SAVE_URL = 'https://fitshop-hub.vercel.app/index.php?page=api_steps_save';

// Keep this in sync with android/app/build.gradle (versionCode)
const APP_VERSION_CODE = 1;

function App() {
  const webRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [stepSyncStatus, setStepSyncStatus] = useState<string>('Starting…');
  const [lastSyncedSteps, setLastSyncedSteps] = useState<number | null>(null);
  const [hcPermissionGranted, setHcPermissionGranted] = useState<boolean>(false);
  const [lastReadSteps, setLastReadSteps] = useState<number | null>(null);
  const [lastSyncDetails, setLastSyncDetails] = useState<string>('');
  const tokenRef = useRef<string>('');
  const hcReadyRef = useRef<boolean>(false);
  const hcRequestInFlightRef = useRef<boolean>(false);
  const syncTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const userAgent = useMemo(() => {
    const base = Platform.OS === 'android' ? 'Android' : Platform.OS;
    return `FitshopHubMobile/${APP_VERSION_CODE} (${base})`;
  }, []);

  const showSyncBar = useMemo(() => {
    const s = String(stepSyncStatus || '').toLowerCase();
    const needsAction =
      !hcPermissionGranted ||
      s.includes('permission') ||
      s.includes('not available') ||
      s.includes('failed') ||
      s.includes('waiting') ||
      s.includes('syncing');
    return needsAction;
  }, [hcPermissionGranted, stepSyncStatus]);

  const showTopBar = false;

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

  const ensureHealthConnectReady = useCallback(async () => {
    if (Platform.OS !== 'android') {
      return false;
    }

    // Only consider it "ready" after the user explicitly grants permission.
    if (hcReadyRef.current) {
      return true;
    }

    const ok = await initialize().catch(() => false);
    if (!ok) {
      setStepSyncStatus('Health Connect not available');
      return false;
    }

    setStepSyncStatus('Checking steps permission…');
    return false;
  }, []);

  const readTodaySteps = useCallback(async (): Promise<number> => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();

    try {
      const { records } = await readRecords('Steps', {
        timeRangeFilter: {
          operator: 'between',
          startTime: start.toISOString(),
          endTime: end.toISOString(),
        },
      } as any);

      const arr: any[] = Array.isArray(records) ? records : [];
      let total = 0;
      for (const r of arr) {
        const v = (r && (r.count ?? r.steps ?? r.value ?? r.quantity)) as any;
        const n = Number(v);
        if (Number.isFinite(n)) total += n;
      }
      const steps = Math.max(0, Math.floor(total));
      setLastReadSteps(steps);
      setLastSyncDetails(`read=${steps}`);
      return steps;
    } catch (e: any) {
      setLastSyncDetails(`read_error=${String(e?.message ?? e)}`);
      throw e;
    }
  }, []);

  const requestStepsPermission = useCallback(async () => {
    if (Platform.OS !== 'android') return;

    if (hcRequestInFlightRef.current) return;
    hcRequestInFlightRef.current = true;

    setStepSyncStatus('Preparing step sync…');
    try {
      const ok = await initialize().catch(() => false);
      if (!ok) {
        setStepSyncStatus('Health Connect not available');
        return;
      }

      // Avoid calling native permission dialog because it crashes on some devices.
      // Instead, verify permission by attempting to read steps.
      await new Promise<void>((resolve) => {
        InteractionManager.runAfterInteractions(() => {
          setTimeout(() => resolve(), 300);
        });
      });

      // If permission is missing this may throw; caller/auto-check will handle.
      const _ = await readTodaySteps();
      hcReadyRef.current = true;
      setHcPermissionGranted(true);
      setStepSyncStatus('Health Connect ready');
    } finally {
      hcRequestInFlightRef.current = false;
    }
  }, [readTodaySteps]);

  const autoSetupSteps = useCallback(async () => {
    if (Platform.OS !== 'android') return;

    const ok = await initialize().catch(() => false);
    if (!ok) {
      setStepSyncStatus('Health Connect not available');
      return;
    }

    // Try reading once to confirm permission + data access.
    const steps = await readTodaySteps().catch((e) => {
      setHcPermissionGranted(false);
      hcReadyRef.current = false;
      setStepSyncStatus('Steps permission needed (open Health Connect and allow Steps)');
      setLastSyncDetails(`read_failed=${String((e as any)?.message ?? e)}`);
      return null;
    });

    if (steps === null) return;

    hcReadyRef.current = true;
    setHcPermissionGranted(true);
    setStepSyncStatus('Health Connect ready');
  }, [readTodaySteps]);

  const syncStepsOnce = useCallback(async () => {
    const token = tokenRef.current;
    if (!token) {
      setStepSyncStatus('Waiting for login…');
      return;
    }

    const ready = await ensureHealthConnectReady();
    if (!ready) {
      return;
    }

    setStepSyncStatus('Syncing…');
    const steps = await readTodaySteps().catch((e) => {
      setStepSyncStatus('Read steps failed');
      setLastSyncDetails(`read_failed=${String((e as any)?.message ?? e)}`);
      return null;
    });

    if (steps === null) {
      return;
    }

    // Avoid spamming the server if nothing changed.
    if (lastSyncedSteps !== null && steps === lastSyncedSteps) {
      setStepSyncStatus('Up to date');
      return;
    }

    const resp = await fetch(STEPS_SAVE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ steps }),
    });

    const json = await resp.json().catch(() => null);
    if (!resp.ok || !json || !json.ok) {
      setStepSyncStatus('Sync failed');
      setLastSyncDetails(`sync_http=${resp.status} ok=${String(json?.ok ?? '')}`);
      return;
    }

    setLastSyncedSteps(steps);
    setStepSyncStatus(`Synced: ${steps} steps`);
    setLastSyncDetails(`read=${steps} synced`);
  }, [ensureHealthConnectReady, lastSyncedSteps, readTodaySteps]);

  useEffect(() => {
    let alive = true;

    (async () => {
      const stored = await AsyncStorage.getItem('fh_api_token').catch(() => null);
      if (!alive) return;
      if (stored) {
        tokenRef.current = stored;
        setStepSyncStatus('Token ready');
      } else {
        setStepSyncStatus('Waiting for login…');
      }

      // Auto-run Health Connect setup when the app starts.
      // This avoids needing the user to press Enable Steps every time.
      if (Platform.OS === 'android') {
        setTimeout(() => {
          autoSetupSteps().catch(() => {
            // keep status from autoSetupSteps
          });
        }, 1200);
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    // Foreground auto sync: run once shortly after app opens, then every 60s.
    if (syncTimerRef.current) {
      clearInterval(syncTimerRef.current);
      syncTimerRef.current = null;
    }

    syncTimerRef.current = setInterval(() => {
      syncStepsOnce().catch(() => {
        setStepSyncStatus('Sync failed');
      });
    }, 60_000);

    // Initial sync attempt
    setTimeout(() => {
      syncStepsOnce().catch(() => {
        setStepSyncStatus('Sync failed');
      });
    }, 3_000);

    return () => {
      if (syncTimerRef.current) {
        clearInterval(syncTimerRef.current);
        syncTimerRef.current = null;
      }
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

        {showSyncBar ? (
          <View style={styles.syncBar}>
            <Text style={styles.syncText}>{stepSyncStatus}</Text>
            {!hcPermissionGranted ? (
              <Pressable
                onPress={() => requestStepsPermission().catch(() => setStepSyncStatus('Permission failed'))}
                style={({ pressed }) => [styles.actionBtn, pressed && styles.actionBtnPressed]}
              >
                <Text style={styles.actionText}>Enable Steps</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <View style={styles.webWrap}>
          <WebView
            ref={webRef}
            source={{ uri: SITE_URL }}
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
                  setStepSyncStatus('Token ready');

                  // If the user logged in while the app is already open, try enabling step sync automatically.
                  if (Platform.OS === 'android') {
                    setTimeout(() => {
                      autoSetupSteps().catch(() => {
                        // keep status from autoSetupSteps
                      });
                    }, 500);
                  }
                }
              } catch {
                // ignore
              }
            }}
            allowsBackForwardNavigationGestures
            setSupportMultipleWindows={false}
          />

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
});

export default App;
