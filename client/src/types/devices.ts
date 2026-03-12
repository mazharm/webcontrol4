export type DeviceSource = "control4" | "ring";
export type DeviceType = "light" | "thermostat" | "lock" | "sensor" | "camera" | "security" | "media";

export interface UnifiedDevice {
  id: string;
  source: DeviceSource;
  type: DeviceType;
  name: string;
  roomId: number | null;
  roomName: string;
  floorName: string;
  zoneName: string | null;
  state: DeviceState;
  lastUpdated: number;
}

export type DeviceState =
  | LightState
  | ThermostatState
  | LockState
  | SensorState
  | CameraState
  | SecurityState
  | MediaState;

export interface LightState {
  type: "light";
  on: boolean;
  level: number;
}

export interface ThermostatState {
  type: "thermostat";
  currentTempF: number;
  heatSetpointF: number;
  coolSetpointF: number;
  hvacMode: "Off" | "Heat" | "Cool" | "Auto";
  hvacState: string;
  humidity: number;
  fanMode: string;
}

export interface LockState {
  type: "lock";
  locked: boolean;
  lastAction: string;
  batteryLevel: number;
}

export interface SensorState {
  type: "sensor";
  sensorKind: "contact" | "motion" | "flood" | "tilt" | "glassbreak";
  triggered: boolean;
  lastTriggered: number | null;
  batteryLevel?: number;
}

export interface CameraState {
  type: "camera";
  online: boolean;
  hasLight: boolean;
  lightOn: boolean;
  hasSiren: boolean;
  sirenOn: boolean;
  snapshotUrl: string | null;
}

export interface SecurityState {
  type: "security";
  mode: "disarmed" | "home" | "away";
  partitionState: string;
  alarmType: string;
}

export interface MediaState {
  type: "media";
  powerOn: boolean;
  currentMedia: string;
  volume: number;
}

export interface Room {
  id: number;
  name: string;
  floorName: string;
}

export interface Zone {
  name: string;
  rooms: Room[];
}

export interface Alert {
  id: string;
  type: "door_open" | "hvac_long" | "low_battery" | "temp_range";
  message: string;
  deviceId: string;
  deviceName: string;
  timestamp: number;
}

export interface FloorNode {
  name: string;
  rooms: RoomNode[];
  isExpanded: boolean;
}

export interface RoomNode {
  id: number;
  name: string;
  lightsOn: number;
  totalLights: number;
  tempF: number | null;
  hasCamera: boolean;
}

export interface Controller {
  commonName: string;
  name: string;
  address: string;
}

export interface Routine {
  id: string;
  name: string;
  steps: RoutineStep[];
  schedule?: RoutineSchedule;
}

export interface RoutineStep {
  type: "light_level" | "light_power" | "light_toggle" | "hvac_mode" | "heat_setpoint" | "cool_setpoint";
  deviceId: number;
  deviceName: string;
  level?: number;
  on?: boolean;
  mode?: "Off" | "Heat" | "Cool" | "Auto";
  value?: number;
}

export interface RoutineSchedule {
  enabled: boolean;
  time: string;
  days: number[];
}

export interface Scene {
  id: number;
  name: string;
  roomId: number;
  roomName: string;
}
