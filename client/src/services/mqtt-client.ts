// ---------------------------------------------------------------------------
// services/mqtt-client.ts – Browser MQTT client singleton
// ---------------------------------------------------------------------------

import mqtt, { type MqttClient, type IClientOptions } from "mqtt";
import { getMqttConfig } from "../config/transport";

export type MqttConnectionState = "connected" | "reconnecting" | "disconnected";

type ConnectionListener = (state: MqttConnectionState) => void;
type MessageHandler = (payload: unknown, topic: string) => void;

let client: MqttClient | null = null;
let connectionState: MqttConnectionState = "disconnected";
const connectionListeners = new Set<ConnectionListener>();
const topicHandlers = new Map<string, Set<MessageHandler>>();

function setConnectionState(state: MqttConnectionState) {
  connectionState = state;
  for (const listener of connectionListeners) {
    try {
      listener(state);
    } catch {
      // ignore
    }
  }
}

export function getConnectionState(): MqttConnectionState {
  return connectionState;
}

export function onConnectionChange(listener: ConnectionListener): () => void {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
}

export function connectMqtt(): MqttClient {
  if (client) return client;

  const config = getMqttConfig();

  const opts: IClientOptions = {
    username: config.username,
    password: config.password,
    clientId: `wc4-client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    clean: true,
    connectTimeout: 10_000,
    reconnectPeriod: 2000,
  };

  client = mqtt.connect(config.brokerWsUrl, opts);

  client.on("connect", () => {
    setConnectionState("connected");

    // Re-subscribe on reconnect
    for (const topic of topicHandlers.keys()) {
      client!.subscribe(topic, { qos: 1 });
    }
  });

  client.on("reconnect", () => {
    setConnectionState("reconnecting");
  });

  client.on("close", () => {
    setConnectionState("disconnected");
  });

  client.on("error", (err) => {
    console.error("[mqtt-client] Error:", err.message);
  });

  client.on("message", (topic: string, payload: Buffer) => {
    const parsed = safeParseJSON(payload);

    // Check exact and wildcard matches
    for (const [pattern, handlers] of topicHandlers) {
      if (topicMatchesPattern(topic, pattern)) {
        for (const handler of handlers) {
          try {
            handler(parsed, topic);
          } catch {
            // ignore handler errors
          }
        }
      }
    }
  });

  // Disconnect on page unload
  window.addEventListener("beforeunload", () => {
    if (client) {
      client.end(true);
      client = null;
    }
  });

  return client;
}

export function subscribe(topic: string, handler: MessageHandler): () => void {
  if (!topicHandlers.has(topic)) {
    topicHandlers.set(topic, new Set());
    if (client?.connected) {
      client.subscribe(topic, { qos: 1 });
    }
  }
  topicHandlers.get(topic)!.add(handler);

  return () => {
    const handlers = topicHandlers.get(topic);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        topicHandlers.delete(topic);
        if (client?.connected) {
          client.unsubscribe(topic);
        }
      }
    }
  };
}

export function publish(topic: string, payload: unknown): void {
  if (!client?.connected) {
    console.warn("[mqtt-client] Cannot publish, not connected");
    return;
  }
  const message = typeof payload === "string" ? payload : JSON.stringify(payload);
  client.publish(topic, message, { qos: 1 });
}

export function disconnectMqtt(): void {
  if (client) {
    client.end(true);
    client = null;
    setConnectionState("disconnected");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseJSON(buffer: Buffer): unknown {
  try {
    return JSON.parse(buffer.toString());
  } catch {
    return buffer.toString();
  }
}

function topicMatchesPattern(topic: string, pattern: string): boolean {
  const topicParts = topic.split("/");
  const patternParts = pattern.split("/");

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] === "#") return true;
    if (patternParts[i] === "+") continue;
    if (patternParts[i] !== topicParts[i]) return false;
  }

  return topicParts.length === patternParts.length;
}
