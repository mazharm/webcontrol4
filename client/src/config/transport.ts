// ---------------------------------------------------------------------------
// config/transport.ts – Transport mode detection + MQTT configuration
// ---------------------------------------------------------------------------

export type TransportMode = "local" | "mqtt";

export const transportMode: TransportMode =
  (import.meta.env.VITE_TRANSPORT as TransportMode) || "local";

export function isRemoteMode(): boolean {
  return transportMode === "mqtt";
}

export interface MqttConfig {
  brokerWsUrl: string;
  username: string;
  password: string;
  homeId: string;
}

let _mqttConfig: MqttConfig | null = null;

const MQTT_STORAGE_KEY = "wc4_mqtt_config";

export function getMqttConfig(): MqttConfig {
  if (_mqttConfig) return _mqttConfig;

  // Try build-time env vars first
  const brokerWsUrl = import.meta.env.VITE_MQTT_BROKER_WS_URL as string;
  const username = import.meta.env.VITE_MQTT_USERNAME as string;
  const password = import.meta.env.VITE_MQTT_PASSWORD as string;
  const homeId = (import.meta.env.VITE_MQTT_HOME_ID as string) || "home1";

  if (brokerWsUrl && username && password) {
    _mqttConfig = { brokerWsUrl, username, password, homeId };
    return _mqttConfig;
  }

  // Fall back to sessionStorage (for remote mode without baked-in secrets)
  try {
    const stored = sessionStorage.getItem(MQTT_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as MqttConfig;
      if (parsed.brokerWsUrl && parsed.username && parsed.password) {
        _mqttConfig = parsed;
        return _mqttConfig;
      }
    }
  } catch { /* ignore */ }

  throw new Error("Missing MQTT configuration");
}

export function hasMqttConfig(): boolean {
  try {
    getMqttConfig();
    return true;
  } catch {
    return false;
  }
}

export function saveMqttConfig(config: MqttConfig): void {
  _mqttConfig = config;
  sessionStorage.setItem(MQTT_STORAGE_KEY, JSON.stringify(config));
}

export function clearMqttConfig(): void {
  _mqttConfig = null;
  sessionStorage.removeItem(MQTT_STORAGE_KEY);
}
