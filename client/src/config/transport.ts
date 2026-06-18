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
const MQTT_HOME_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function normalizeMqttConfig(config: MqttConfig): MqttConfig {
  const brokerWsUrl = config.brokerWsUrl.trim();
  const username = config.username.trim();
  const password = config.password;
  const homeId = (config.homeId || "home1").trim();

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(brokerWsUrl);
  } catch {
    throw new Error("MQTT broker URL is invalid.");
  }

  if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
    throw new Error("MQTT broker URL must use ws:// or wss://.");
  }
  if (!parsedUrl.hostname || parsedUrl.username || parsedUrl.password) {
    throw new Error("MQTT broker URL must include a host and no embedded credentials.");
  }
  if (!username || !password) {
    throw new Error("MQTT username and password are required.");
  }
  if (!MQTT_HOME_ID_RE.test(homeId)) {
    throw new Error("MQTT Home ID may only contain letters, numbers, underscores, and hyphens.");
  }

  return { brokerWsUrl, username, password, homeId };
}

export function getMqttConfig(): MqttConfig {
  if (_mqttConfig) return _mqttConfig;

  // Try build-time env vars first
  const brokerWsUrl = import.meta.env.VITE_MQTT_BROKER_WS_URL as string;
  const username = import.meta.env.VITE_MQTT_USERNAME as string;
  const password = import.meta.env.VITE_MQTT_PASSWORD as string;
  const homeId = (import.meta.env.VITE_MQTT_HOME_ID as string) || "home1";

  if (brokerWsUrl && username && password) {
    _mqttConfig = normalizeMqttConfig({ brokerWsUrl, username, password, homeId });
    return _mqttConfig;
  }

  // Clear legacy configs that stored MQTT passwords in sessionStorage.
  try {
    sessionStorage.removeItem(MQTT_STORAGE_KEY);
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
  _mqttConfig = normalizeMqttConfig(config);
  try {
    sessionStorage.removeItem(MQTT_STORAGE_KEY);
  } catch { /* ignore */ }
}

export function clearMqttConfig(): void {
  _mqttConfig = null;
  sessionStorage.removeItem(MQTT_STORAGE_KEY);
}
