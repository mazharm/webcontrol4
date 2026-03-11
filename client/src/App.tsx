import { useEffect, useCallback } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { FluentProvider } from "@fluentui/react-components";
import { useTheme } from "./contexts/ThemeContext";
import { useAuth } from "./contexts/AuthContext";
import { useDeviceContext } from "./contexts/DeviceContext";
import { useSSE } from "./hooks/useSSE";
import { lightTheme, darkTheme } from "./theme";
import { getState } from "./api/director";
import { getCameras, getSensors, getAlarmMode } from "./api/ring";
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
import { HistoryView } from "./components/history/HistoryView";
import { RoutinesView } from "./components/routines/RoutinesView";
import { SettingsView } from "./components/settings/SettingsView";

function ConnectedApp() {
  const { dispatch } = useDeviceContext();

  // SSE for realtime updates
  useSSE(dispatch);

  // Initial data load
  const loadDevices = useCallback(async () => {
    try {
      const snapshot: StateSnapshot = await getState();

      // Map C4 devices from state machine
      const c4Devices = mapStateDevices(snapshot);

      // Map alerts
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

      // Try to load Ring devices
      let ringDevices: UnifiedDevice[] = [];
      try {
        const [cameras, sensors] = await Promise.all([
          getCameras().catch(() => []),
          getSensors().catch(() => []),
        ]);
        ringDevices = [
          ...cameras.map((c) => mapRingCamera(c)),
          ...sensors.map((s) => mapRingSensor(s)),
        ];

        // Try to get alarm mode and create a security device
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
                mode: alarm.mode as "disarmed" | "home" | "away",
                partitionState: alarm.mode,
                alarmType: "",
              },
              lastUpdated: Date.now(),
            });
          }
        } catch { /* Ring alarm not available */ }
      } catch { /* Ring not connected */ }

      dispatch({ type: "SET_DEVICES", payload: [...c4Devices, ...ringDevices] });

      // Load scenes from state if available
      // Scenes come from Director categories, try to fetch from snapshot or ignore
    } catch (err) {
      console.error("Failed to load devices:", err);
    }
  }, [dispatch]);

  useEffect(() => {
    loadDevices();
    // Refresh every 30 seconds as fallback
    const interval = setInterval(loadDevices, 30000);
    return () => clearInterval(interval);
  }, [loadDevices]);

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomeDashboard />} />
        <Route path="/room/:roomId" element={<RoomView />} />
        <Route path="/floor/:floorName" element={<FloorOverview />} />
        <Route path="/lights" element={<AllLightsView />} />
        <Route path="/climate" element={<AllClimateView />} />
        <Route path="/security" element={<AllSecurityView />} />
        <Route path="/cameras" element={<AllSecurityView />} />
        <Route path="/history" element={<HistoryView />} />
        <Route path="/routines" element={<RoutinesView />} />
        <Route path="/settings" element={<SettingsView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
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
