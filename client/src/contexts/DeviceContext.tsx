import { createContext, useContext, useReducer, type ReactNode, type Dispatch } from "react";
import type { UnifiedDevice, Alert, Room, Zone, Scene } from "../types/devices";

export interface DeviceContextState {
  devices: Map<string, UnifiedDevice>;
  rooms: Map<number, Room>;
  floors: string[];
  zones: Zone[];
  scenes: Scene[];
  alerts: Alert[];
  connectionStatus: "connected" | "connecting" | "disconnected";
  lastRefresh: number;
}

export type DeviceAction =
  | { type: "SET_DEVICES"; payload: UnifiedDevice[] }
  | { type: "UPDATE_DEVICE"; payload: { id: string; state: Partial<UnifiedDevice["state"]> } }
  | { type: "UPDATE_DEVICE_VAR"; payload: { itemId: number; varName: string; value: string; deviceName?: string; room?: string; roomId?: number; floor?: string; deviceType?: string } }
  | { type: "SET_SCENES"; payload: Scene[] }
  | { type: "SET_ALERTS"; payload: Alert[] }
  | { type: "SET_CONNECTION"; payload: DeviceContextState["connectionStatus"] }
  | { type: "REFRESH_ALL" };

const initialState: DeviceContextState = {
  devices: new Map(),
  rooms: new Map(),
  floors: [],
  zones: [],
  scenes: [],
  alerts: [],
  connectionStatus: "disconnected",
  lastRefresh: 0,
};

function isLightOnValue(value: string): boolean {
  return value === "1" || value === "true" || value === "on" || value === "On";
}

function updateDeviceVar(state: DeviceContextState, payload: DeviceAction & { type: "UPDATE_DEVICE_VAR" } extends { payload: infer P } ? P : never): DeviceContextState {
  const { itemId, varName, value } = payload as { itemId: number; varName: string; value: string };
  const deviceId = `control4:${itemId}`;
  const existing = state.devices.get(deviceId);
  if (!existing) return state;

  const newDevices = new Map(state.devices);
  const updated = { ...existing, lastUpdated: Date.now() };

  if (updated.type === "light") {
    const s = { ...(updated.state as { type: "light"; on: boolean; level: number }) };
    if (varName === "LIGHT_LEVEL") {
      s.level = parseInt(value, 10) || 0;
      s.on = s.level > 0;
    } else if (varName === "LIGHT_STATE") {
      s.on = isLightOnValue(value);
      if (!s.on) s.level = 0;
    }
    updated.state = s;
  } else if (updated.type === "thermostat") {
    const s = { ...(updated.state as import("../types/devices").ThermostatState) };
    if (varName === "TEMPERATURE_F") s.currentTempF = parseFloat(value) || 0;
    else if (varName === "HEAT_SETPOINT_F") s.heatSetpointF = parseFloat(value) || 68;
    else if (varName === "COOL_SETPOINT_F") s.coolSetpointF = parseFloat(value) || 74;
    else if (varName === "HVAC_MODE") s.hvacMode = value as "Off" | "Heat" | "Cool" | "Auto";
    else if (varName === "HVAC_STATE") s.hvacState = value;
    else if (varName === "HUMIDITY") s.humidity = parseFloat(value) || 0;
    else if (varName === "FAN_MODE") s.fanMode = value;
    updated.state = s;
  } else if (updated.type === "lock") {
    const s = { ...(updated.state as { type: "lock"; locked: boolean; lastAction: string; batteryLevel: number }) };
    if (varName === "LOCK_STATE") s.locked = value === "locked" || value === "1";
    else if (varName === "LAST_ACTION") s.lastAction = value;
    else if (varName === "BATTERY_LEVEL") s.batteryLevel = parseInt(value, 10) || 0;
    updated.state = s;
  } else if (updated.type === "sensor") {
    const s = { ...(updated.state as import("../types/devices").SensorState) };
    if (varName === "CONTACT_STATE") {
      s.triggered = value === "1" || value === "Open";
      if (s.triggered) s.lastTriggered = Date.now();
    } else if (varName === "MOTION_STATE" || varName === "MOTION_DETECTED") {
      s.triggered = value === "1";
      if (s.triggered) s.lastTriggered = Date.now();
    } else if (varName === "BATTERY_LEVEL") {
      s.batteryLevel = parseInt(value, 10);
    }
    updated.state = s;
  } else if (updated.type === "security") {
    const s = { ...(updated.state as import("../types/devices").SecurityState) };
    if (varName === "PARTITION_STATE") {
      s.partitionState = value;
      const lv = value.toLowerCase();
      if (lv.includes("away")) s.mode = "away";
      else if (lv.includes("home") || lv.includes("stay")) s.mode = "home";
      else s.mode = "disarmed";
    } else if (varName === "ALARM_TYPE") s.alarmType = value;
    updated.state = s;
  } else if (updated.type === "media") {
    const s = { ...(updated.state as { type: "media"; powerOn: boolean; currentMedia: string; volume: number }) };
    if (varName === "POWER_STATE") s.powerOn = value === "1" || value === "On";
    else if (varName === "CURRENT_MEDIA_INFO") s.currentMedia = value;
    else if (varName === "CURRENT_VOLUME") s.volume = parseInt(value, 10) || 0;
    updated.state = s;
  }

  newDevices.set(deviceId, updated);
  return { ...state, devices: newDevices };
}

function deviceReducer(state: DeviceContextState, action: DeviceAction): DeviceContextState {
  switch (action.type) {
    case "SET_DEVICES": {
      const devices = new Map<string, UnifiedDevice>();
      const rooms = new Map<number, Room>();
      const floorSet = new Set<string>();
      const zoneMap = new Map<string, Zone>();

      for (const d of action.payload) {
        devices.set(d.id, d);
        if (d.roomId != null) {
          rooms.set(d.roomId, { id: d.roomId, name: d.roomName, floorName: d.floorName });
        }
        if (d.floorName) floorSet.add(d.floorName);
        if (d.zoneName) {
          if (!zoneMap.has(d.zoneName)) {
            zoneMap.set(d.zoneName, { name: d.zoneName, rooms: [] });
          }
        }
      }

      return {
        ...state,
        devices,
        rooms,
        floors: Array.from(floorSet).sort(),
        zones: Array.from(zoneMap.values()),
        lastRefresh: Date.now(),
      };
    }
    case "UPDATE_DEVICE": {
      const newDevices = new Map(state.devices);
      const existing = newDevices.get(action.payload.id);
      if (existing) {
        newDevices.set(action.payload.id, {
          ...existing,
          state: { ...existing.state, ...action.payload.state } as UnifiedDevice["state"],
          lastUpdated: Date.now(),
        });
      }
      return { ...state, devices: newDevices };
    }
    case "UPDATE_DEVICE_VAR":
      return updateDeviceVar(state, action.payload);
    case "SET_SCENES":
      return { ...state, scenes: action.payload };
    case "SET_ALERTS":
      return {
        ...state,
        alerts: action.payload.map((a) => {
          const alert = a as Alert;
          if (!alert.id) {
            return { ...alert, id: `${alert.type}-${alert.deviceId || alert.deviceName}-${alert.timestamp}` };
          }
          return alert;
        }),
      };
    case "SET_CONNECTION":
      return { ...state, connectionStatus: action.payload };
    case "REFRESH_ALL":
      return { ...state, lastRefresh: Date.now() };
    default:
      return state;
  }
}

interface DeviceContextValue {
  state: DeviceContextState;
  dispatch: Dispatch<DeviceAction>;
}

const DeviceContext = createContext<DeviceContextValue>({
  state: initialState,
  dispatch: () => {},
});

export function DeviceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(deviceReducer, initialState);
  return (
    <DeviceContext.Provider value={{ state, dispatch }}>
      {children}
    </DeviceContext.Provider>
  );
}

export function useDeviceContext() {
  return useContext(DeviceContext);
}
