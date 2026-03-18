// ---------------------------------------------------------------------------
// contexts/MqttProvider.tsx – MQTT → DeviceContext bridge
// ---------------------------------------------------------------------------
// Subscribes to all MQTT state topics and feeds the existing DeviceContext.
// Renders connection status banners.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import { MessageBar, MessageBarBody, MessageBarTitle, tokens, makeStyles } from "@fluentui/react-components";
import {
  connectMqtt,
  subscribe,
  onConnectionChange,
  disconnectMqtt,
  type MqttConnectionState,
} from "../services/mqtt-client";
import { getMqttConfig } from "../config/transport";
import { useDeviceContext } from "./DeviceContext";
import type { UnifiedDevice, Alert, Scene } from "../types/devices";
import { normalizeRoomId } from "../utils/deviceMapping";

const useStyles = makeStyles({
  banner: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 9999,
  },
});

interface MqttDevicePayload {
  id: string;
  source: "control4" | "ring" | "govee";
  type: "light" | "thermostat" | "lock" | "sensor" | "camera" | "security" | "media";
  name: string;
  roomId: number | null;
  roomName: string;
  floorName: string;
  zoneName?: string | null;
  state: UnifiedDevice["state"];
  ts: string;
}

export function MqttProvider({ children }: { children: React.ReactNode }) {
  const styles = useStyles();
  const { dispatch } = useDeviceContext();
  const [connectionState, setConnectionState] = useState<MqttConnectionState>("disconnected");
  const [bridgeOnline, setBridgeOnline] = useState<boolean | null>(null);
  const devicesRef = useRef(new Map<string, UnifiedDevice>());
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initializedRef = useRef(false);
  const bridgeGraceRef = useRef(false);

  useEffect(() => {
    const config = getMqttConfig();
    const homeId = config.homeId;

    // Connect to MQTT broker
    connectMqtt();
    dispatch({ type: "SET_CONNECTION", payload: "connecting" });

    // Track connection state
    const unsubConnection = onConnectionChange((state) => {
      setConnectionState(state);
      if (state === "connected") {
        // If we were already initialized, this is a reconnect —
        // reset so incoming retained messages are re-batched into SET_DEVICES
        if (initializedRef.current) {
          initializedRef.current = false;
          devicesRef.current.clear();
        }
        dispatch({ type: "SET_CONNECTION", payload: "connected" });
      } else if (state === "disconnected") {
        dispatch({ type: "SET_CONNECTION", payload: "disconnected" });
      }
    });

    // Subscribe to all device state topics
    const unsubDevices = subscribe(`wc4/${homeId}/state/#`, (payload: unknown, topic: string) => {
      // Parse topic to determine what kind of state this is
      const prefix = `wc4/${homeId}/state/`;
      const remainder = topic.slice(prefix.length);

      // Home state
      if (remainder === "home") {
        const data = payload as { alerts?: Alert[] };
        if (data.alerts) {
          dispatch({ type: "SET_ALERTS", payload: data.alerts });
        }
        return;
      }

      // Scenes
      if (remainder === "scenes") {
        if (Array.isArray(payload)) {
          dispatch({ type: "SET_SCENES", payload: payload as Scene[] });
        }
        return;
      }

      // Routine list / results — handled by useMqttRoutines hook, skip here
      if (remainder.startsWith("routines/")) return;

      // Device state: state/{system}/{deviceId}
      const parts = remainder.split("/");
      if (parts.length === 2) {
        const mqttPayload = payload as MqttDevicePayload;
        if (!mqttPayload?.id || !mqttPayload?.type || !mqttPayload?.state) return;
        const roomName = mqttPayload.roomName || "";
        const floorName = mqttPayload.floorName || "";

        const device: UnifiedDevice = {
          id: mqttPayload.id,
          source: mqttPayload.source === "govee" ? "ring" : mqttPayload.source, // map govee to ring for DeviceSource compat
          type: mqttPayload.type,
          name: mqttPayload.name,
          roomId: normalizeRoomId(mqttPayload.roomId, roomName, floorName),
          roomName,
          floorName,
          zoneName: mqttPayload.zoneName ?? null,
          state: mqttPayload.state,
          lastUpdated: Date.now(),
        };

        const existing = devicesRef.current.get(device.id);
        const mergedDevice = existing
          ? { ...existing, ...device, state: device.state, lastUpdated: device.lastUpdated }
          : device;
        devicesRef.current.set(device.id, mergedDevice);

        if (!initializedRef.current) {
          // Collecting retained messages — batch them
          resetSettleTimer();
        } else {
          const metadataChanged = !existing
            || existing.name !== mergedDevice.name
            || existing.type !== mergedDevice.type
            || existing.source !== mergedDevice.source
            || existing.roomId !== mergedDevice.roomId
            || existing.roomName !== mergedDevice.roomName
            || existing.floorName !== mergedDevice.floorName
            || existing.zoneName !== mergedDevice.zoneName;

          if (metadataChanged) {
            dispatch({ type: "SET_DEVICES", payload: Array.from(devicesRef.current.values()) });
          } else {
            dispatch({
              type: "UPDATE_DEVICE",
              payload: { id: mergedDevice.id, state: mergedDevice.state },
            });
          }
        }
      }
    });

    // Subscribe to bridge status — grace period avoids flash from stale LWT retained msg
    const bridgeGraceTimer = setTimeout(() => {
      bridgeGraceRef.current = true;
    }, 5000);
    const unsubBridge = subscribe(`wc4/${homeId}/status/bridge`, (payload: unknown) => {
      const data = payload as { online?: boolean };
      const online = data.online ?? false;
      if (online || bridgeGraceRef.current) {
        setBridgeOnline(online);
      }
    });

    function resetSettleTimer() {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = setTimeout(() => {
        // Settling period over — dispatch all collected devices
        const allDevices = Array.from(devicesRef.current.values());
        if (allDevices.length > 0) {
          dispatch({ type: "SET_DEVICES", payload: allDevices });
        }
        initializedRef.current = true;
        dispatch({ type: "SET_CONNECTION", payload: "connected" });
      }, 800);
    }

    // If no retained messages arrive within 3s, consider init done
    const initTimeout = setTimeout(() => {
      if (!initializedRef.current) {
        const allDevices = Array.from(devicesRef.current.values());
        if (allDevices.length > 0) {
          dispatch({ type: "SET_DEVICES", payload: allDevices });
        }
        initializedRef.current = true;
        dispatch({ type: "SET_CONNECTION", payload: "connected" });
      }
    }, 3000);

    return () => {
      unsubConnection();
      unsubDevices();
      unsubBridge();
      clearTimeout(initTimeout);
      clearTimeout(bridgeGraceTimer);
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      disconnectMqtt();
    };
  }, [dispatch]);

  return (
    <>
      {connectionState === "disconnected" && (
        <div className={styles.banner}>
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Disconnected</MessageBarTitle>
              Connection to the server lost. Attempting to reconnect...
            </MessageBarBody>
          </MessageBar>
        </div>
      )}
      {connectionState === "reconnecting" && (
        <div className={styles.banner}>
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Reconnecting</MessageBarTitle>
              Reconnecting to the MQTT broker...
            </MessageBarBody>
          </MessageBar>
        </div>
      )}
      {connectionState === "connected" && bridgeOnline === false && (
        <div className={styles.banner}>
          <MessageBar intent="warning" style={{ backgroundColor: tokens.colorPaletteYellowBackground1 }}>
            <MessageBarBody>
              <MessageBarTitle>Bridge Offline</MessageBarTitle>
              The home bridge is not responding. Device states may be stale.
            </MessageBarBody>
          </MessageBar>
        </div>
      )}
      {children}
    </>
  );
}
