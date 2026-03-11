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
  id: string;
  description: string;
  device_name: string;
  health: { firmware: string; wifi_name: string };
  features: { motions_enabled: boolean; show_recordings: boolean };
  hasLight: boolean;
  hasSiren: boolean;
}

export interface RingSensor {
  id: string;
  name: string;
  deviceType: string;
  faulted: boolean;
  tamperStatus: string;
  batteryLevel?: number;
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
    lastChanged: number;
  }>;
  homeState: {
    mode: string;
    confidence: string;
    signals: string[];
  };
  alerts: Array<{
    type: string;
    message: string;
    itemId: number;
    itemName: string;
    timestamp: number;
  }>;
}

export interface LLMChatRequest {
  message: string;
  context?: string;
  mode?: "control" | "analyze";
}

export interface LLMChatResponse {
  message: string;
  actions?: LLMAction[];
}

export interface LLMAction {
  type: string;
  deviceId: number;
  deviceName: string;
  [key: string]: unknown;
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

export interface SettingsResponse {
  hasAnthropicKey: boolean;
  anthropicModel: string;
  deviceMappings?: Record<string, number>;
}
