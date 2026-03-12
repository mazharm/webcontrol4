export interface AuthLoginResponse {
  accountToken: string;
}

export interface AuthControllersResponse {
  controllers: Array<{
    commonName: string;
    name: string;
    address: string;
  }>;
}

export interface AuthDirectorTokenResponse {
  directorToken: string;
  controllerIp: string;
}

export interface AuthStatusResponse {
  authenticated: boolean;
  user?: { email: string };
}

export interface C4LightItem {
  id: number;
  name: string;
  type: number;
  roomName: string;
  roomParentId: number;
  floorName: string;
}

export interface C4ThermostatItem {
  id: number;
  name: string;
  type: number;
  roomName: string;
  roomParentId: number;
  floorName: string;
}

export interface C4Variable {
  varName: string;
  value: string;
}

export interface C4SceneItem {
  id: number;
  name: string;
  roomName: string;
  roomParentId: number;
}

export interface RingCamera {
  id: number;
  name: string;
  model: string;
  hasLight: boolean;
  hasSiren: boolean;
  hasBattery?: boolean;
  isOffline: boolean;
}

export interface RingSensor {
  zid: string;
  name: string;
  type: string;
  roomId?: number;
  faulted: boolean;
  tamperStatus: string;
  batteryLevel?: number;
  batteryStatus?: string;
  mode?: string;
}

export interface RingStatusResponse {
  connected: boolean;
  status: "disconnected" | "connecting" | "connected" | "error" | string;
  locationCount: number;
  locations: Array<{
    id: string;
    name: string;
    hasHubs: boolean;
  }>;
}

export interface StateSnapshot {
  devices: Record<string, {
    itemId: number;
    name: string;
    type: string;
    room: string;
    roomId: number;
    floor: string;
    variables: Record<string, string>;
    lastChanged: number | null;
  }>;
  home?: {
    mode: string;
    confidence: string;
    signals: string[];
    alerts?: Array<{
      type: string;
      message: string;
      deviceId: number;
      timestamp: number;
    }>;
  };
  homeState: {
    mode: string;
    confidence: string;
    signals: string[];
    alerts?: Array<{
      type: string;
      message: string;
      deviceId: number;
      timestamp: number;
    }>;
  };
  alerts: Array<{
    type: string;
    message: string;
    itemId: number;
    itemName: string;
    timestamp: number;
  }>;
  summary?: string;
  deviceCount?: number;
  roomCount?: number;
}

export interface LLMChatRequest {
  message: string;
  context?: LLMControlContext;
  mode?: "control" | "analyze";
}

export interface LLMChatResponse {
  message: string;
  actions?: LLMAction[];
}

export interface LLMAction {
  type: string;
  deviceId?: number;
  deviceName?: string;
  routineId?: string;
  name?: string;
  steps?: Array<Record<string, unknown>>;
  schedule?: {
    enabled?: boolean;
    time?: string;
    days?: number[];
  };
  [key: string]: unknown;
}

export interface LLMContextDevice {
  id: number;
  type: "light" | "thermostat";
  name: string;
  floor: string;
  room: string;
  on?: boolean;
  level?: number;
  tempF?: number;
  heatF?: number;
  coolF?: number;
  hvacMode?: string;
}

export interface LLMContextRoutine {
  id: string;
  name: string;
}

export interface LLMControlContext {
  devices?: LLMContextDevice[];
  routines?: LLMContextRoutine[];
  historySummary?: string;
}

export interface HistoryPoint {
  ts: number;
  on?: boolean;
  level?: number;
  tempF?: number;
  heatF?: number;
  coolF?: number;
  hvacMode?: string;
  onCount?: number;
}

export interface FloorHistorySeries {
  floor: string;
  points: HistoryPoint[];
}

export interface SettingsResponse {
  hasAnthropicKey: boolean;
  anthropicModel: string;
  deviceMappings?: Record<string, number>;
}
