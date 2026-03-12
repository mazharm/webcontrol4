import { useEffect, useCallback, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { FluentProvider, Spinner, Text, makeStyles, tokens } from "@fluentui/react-components";
import { useTheme } from "./contexts/ThemeContext";
import { useAuth } from "./contexts/AuthContext";
import { useDeviceContext } from "./contexts/DeviceContext";
import { useSSE } from "./hooks/useSSE";
import { lightTheme, darkTheme } from "./theme";
import { getState } from "./api/director";
import { getCameras, getSensors, getAlarmMode } from "./api/ring";
import { recordHistory } from "./api/history";
import { mapStateDevices, mapRingCamera, mapRingSensor, mapC4Scene } from "./utils/deviceMapping";
import type { UnifiedDevice, Alert } from "./types/devices";
import type { StateSnapshot } from "./types/api";

import { AppShell } from "./components/layout/AppShell";
import { LoginView } from "./components/auth/LoginView";
import { ControllerPicker } from "./components/auth/ControllerPicker";
import { HomeDashboard } from "./components/dashboard/HomeDashboard";
import { RoomView } from "./components/views/RoomView";
import { FloorOverview } from "./components/views/FloorOverview";
import { AllLightsView } from "./components/views/AllLightsView";
import { AllClimateView } from "./components/views/AllClimateView";
import { AllSecurityView } from "./components/views/AllSecurityView";
import { AllCamerasView } from "./components/views/AllCamerasView";
import { HistoryView } from "./components/history/HistoryView";
import { RoutinesView } from "./components/routines/RoutinesView";
import { SettingsView } from "./components/settings/SettingsView";
import { MoreView } from "./components/views/MoreView";
import { WaterLeakView } from "./components/views/WaterLeakView";

const useStyles = makeStyles({
  loadingState: {
    height: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "12px",
    textAlign: "center",
    padding: "24px",
  },
  loadingHint: {
    color: tokens.colorNeutralForeground3,
    maxWidth: "360px",
  },
});

function ConnectedApp() {
  const styles = useStyles();
  const { dispatch } = useDeviceContext();
  const [initializing, setInitializing] = useState(true);

  const loadRingDevices = useCallback(async (): Promise<UnifiedDevice[]> => {
    try {
      const [cameras, sensors] = await Promise.all([
        getCameras().catch(() => []),
        getSensors().catch(() => []),
      ]);

      const ringDevices: UnifiedDevice[] = [
        ...cameras.map((c) => mapRingCamera(c)),
        ...sensors.map((s) => mapRingSensor(s)),
      ];

      try {
        const alarm = await getAlarmMode();
        if (alarm.mode) {
          ringDevices.push({
            id: "ring:alarm",
            source: "ring",
            type: "security",
            name: "Ring Alarm",
            roomId: null,
            roomName: "Outdoor",
            floorName: "",
            zoneName: "Outdoor",
            state: {
              type: "security",
              mode: alarm.mode === "all" ? "away" : alarm.mode === "some" ? "home" : "disarmed",
              partitionState: alarm.mode,
              alarmType: "",
            },
            lastUpdated: Date.now(),
          });
        }
      } catch {
        // Ring alarm not available
      }

      return ringDevices;
    } catch {
      return [];
    }
  }, []);

  // SSE for realtime updates
  useSSE(dispatch);

  const loadC4Snapshot = useCallback(async (): Promise<UnifiedDevice[]> => {
    const snapshot: StateSnapshot = await getState();
    const c4Devices = mapStateDevices(snapshot);

    if (snapshot.alerts) {
      dispatch({
        type: "SET_ALERTS",
        payload: snapshot.alerts.map((a) => ({
          id: `${a.type}-${a.itemId}-${a.timestamp}`,
          type: a.type as Alert["type"],
          message: a.message,
          deviceId: String(a.itemId),
          deviceName: a.itemName,
          timestamp: a.timestamp,
        })),
      });
    }

    return c4Devices;
  }, [dispatch]);

  const captureHistory = useCallback(async (devices: UnifiedDevice[]) => {
    const control4Devices = devices.filter((device) => device.source === "control4");
    if (control4Devices.length === 0) return;
    await recordHistory(control4Devices);
  }, []);

  useEffect(() => {
    let active = true;

    const initializeDevices = async () => {
      dispatch({ type: "SET_CONNECTION", payload: "connecting" });
      try {
        const c4Devices = await loadC4Snapshot();
        if (!active) return;

        dispatch({ type: "SET_DEVICES", payload: c4Devices });
        await captureHistory(c4Devices);
        dispatch({ type: "SET_CONNECTION", payload: "connected" });
        setInitializing(false);

        const ringDevices = await loadRingDevices();
        if (!active || ringDevices.length === 0) return;
        dispatch({ type: "SET_DEVICES", payload: [...c4Devices, ...ringDevices] });
      } catch (err) {
        console.error("Failed to load devices:", err);
        if (!active) return;
        dispatch({ type: "SET_CONNECTION", payload: "disconnected" });
        setInitializing(false);
      }
    };

    const refreshDevices = async () => {
      try {
        const c4Devices = await loadC4Snapshot();
        await captureHistory(c4Devices);
        const ringDevices = await loadRingDevices();
        if (!active) return;
        dispatch({ type: "SET_DEVICES", payload: [...c4Devices, ...ringDevices] });
      } catch (err) {
        console.error("Failed to refresh devices:", err);
      }
    };

    void initializeDevices();
    const interval = setInterval(() => {
      void refreshDevices();
    }, 30000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [captureHistory, dispatch, loadC4Snapshot, loadRingDevices]);

  return (
    <AppShell>
      {initializing ? (
        <div className={styles.loadingState}>
          <Spinner size="large" label="Loading your controller data..." labelPosition="below" />
          <Text className={styles.loadingHint}>
            Your devices are on the way. The first load can take a few seconds, especially while optional integrations finish checking in.
          </Text>
        </div>
      ) : (
        <Routes>
          <Route path="/" element={<HomeDashboard />} />
          <Route path="/room/:roomId" element={<RoomView />} />
          <Route path="/floor/:floorName" element={<FloorOverview />} />
          <Route path="/lights" element={<AllLightsView />} />
          <Route path="/climate" element={<AllClimateView />} />
          <Route path="/security" element={<AllSecurityView />} />
          <Route path="/cameras" element={<AllCamerasView />} />
          <Route path="/water-leak" element={<WaterLeakView />} />
          <Route path="/history" element={<HistoryView />} />
          <Route path="/routines" element={<RoutinesView />} />
          <Route path="/settings" element={<SettingsView />} />
          <Route path="/more" element={<MoreView />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      )}
    </AppShell>
  );
}

export function App() {
  const { mode } = useTheme();
  const { state: auth } = useAuth();

  return (
    <FluentProvider theme={mode === "dark" ? darkTheme : lightTheme} style={{ height: "100%" }}>
      {auth.stage === "checking" && <LoginView />}
      {auth.stage === "login" && <LoginView />}
      {auth.stage === "controller-select" && <ControllerPicker />}
      {auth.stage === "connected" && <ConnectedApp />}
    </FluentProvider>
  );
}
