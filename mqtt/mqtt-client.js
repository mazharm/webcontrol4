// ---------------------------------------------------------------------------
// mqtt/mqtt-client.js – Core MQTT connection manager
// ---------------------------------------------------------------------------
// Connects to HiveMQ Cloud (or any MQTT broker) over mqtts://.
// Provides publish/subscribe wrappers with automatic reconnection and LWT.
// ---------------------------------------------------------------------------

const mqtt = require("mqtt");

let client = null;
let homeId = "";
let connected = false;
const startTime = Date.now();
const subscriptions = new Map(); // topic -> Set<handler>
const reconnectListeners = new Set(); // callbacks invoked after broker reconnect

function getHomeId() {
  return homeId;
}

function isConnected() {
  return connected;
}

/**
 * Connect to the MQTT broker.
 * @param {object} opts
 * @param {string} opts.brokerUrl   - e.g. "mqtts://xxx.hivemq.cloud:8883"
 * @param {string} opts.username
 * @param {string} opts.password
 * @param {string} opts.homeId      - e.g. "home1"
 * @returns {Promise<object>}       - the mqtt client
 */
function connect({ brokerUrl, username, password, homeId: hid }) {
  return new Promise((resolve, reject) => {
    homeId = hid;
    let settled = false;

    const willTopic = `wc4/${homeId}/status/bridge`;
    const willPayload = JSON.stringify({ online: false, ts: new Date().toISOString() });

    // Disable auto-reconnect for initial connection; we enable it after success
    client = mqtt.connect(brokerUrl, {
      username,
      password,
      clientId: `wc4-bridge-${homeId}-${Date.now()}`,
      clean: true,
      connectTimeout: 10_000,
      reconnectPeriod: 0, // disabled until first successful connect
      will: {
        topic: willTopic,
        payload: willPayload,
        qos: 1,
        retain: true,
      },
    });

    client.on("connect", () => {
      const isReconnect = connected === false && settled;
      connected = true;
      // Enable auto-reconnect now that we know credentials are valid
      client.options.reconnectPeriod = 1000;
      console.log("[mqtt] Connected to broker");

      // Re-subscribe to all registered topics on reconnect
      for (const topic of subscriptions.keys()) {
        client.subscribe(topic, { qos: 1 });
      }

      if (!settled) { settled = true; resolve(client); }

      // Notify listeners so they can re-publish retained state
      if (isReconnect) {
        for (const listener of reconnectListeners) {
          try { listener(); } catch (err) {
            console.error("[mqtt] Reconnect listener error:", err.message);
          }
        }
      }
    });

    client.on("reconnect", () => {
      console.log("[mqtt] Reconnecting...");
    });

    client.on("close", () => {
      connected = false;
    });

    client.on("error", (err) => {
      console.error("[mqtt] Error:", err.message);
      if (!settled) {
        settled = true;
        // Clean up the client on initial connection failure
        try { client.end(true); } catch {}
        client = null;
        reject(err);
      }
    });

    client.on("offline", () => {
      connected = false;
      console.log("[mqtt] Offline");
    });

    // Route incoming messages to registered handlers
    client.on("message", (topic, payload) => {
      // Check exact match first
      const handlers = subscriptions.get(topic);
      if (handlers) {
        const parsed = safeParseJSON(payload);
        for (const handler of handlers) {
          try {
            handler(parsed, topic);
          } catch (err) {
            console.error("[mqtt] Handler error:", err.message);
          }
        }
      }

      // Check wildcard matches
      for (const [pattern, patternHandlers] of subscriptions) {
        if (pattern === topic) continue; // already handled
        if (topicMatchesPattern(topic, pattern)) {
          const parsed = safeParseJSON(payload);
          for (const handler of patternHandlers) {
            try {
              handler(parsed, topic);
            } catch (err) {
              console.error("[mqtt] Handler error:", err.message);
            }
          }
        }
      }
    });
  });
}

/**
 * Publish a message.
 * @param {string} topic
 * @param {object|string} payload
 * @param {object} [options]  - { qos, retain }
 */
function publish(topic, payload, options = {}) {
  if (!client || !connected) {
    console.warn("[mqtt] Cannot publish, not connected");
    return;
  }
  const message = typeof payload === "string" ? payload : JSON.stringify(payload);
  client.publish(topic, message, {
    qos: options.qos ?? 1,
    retain: options.retain ?? false,
  });
}

/**
 * Subscribe to a topic with a handler.
 * @param {string} topic   - supports MQTT wildcards (+ and #)
 * @param {function} handler - receives (parsedPayload, topic)
 */
function subscribe(topic, handler) {
  if (!subscriptions.has(topic)) {
    subscriptions.set(topic, new Set());
    if (client && connected) {
      client.subscribe(topic, { qos: 1 });
    }
  }
  subscriptions.get(topic).add(handler);
}

/**
 * Unsubscribe a handler from a topic.
 */
function unsubscribe(topic, handler) {
  const handlers = subscriptions.get(topic);
  if (handlers) {
    handlers.delete(handler);
    if (handlers.size === 0) {
      subscriptions.delete(topic);
      if (client && connected) {
        client.unsubscribe(topic);
      }
    }
  }
}

/**
 * Publish bridge online status and disconnect gracefully.
 */
async function disconnect() {
  if (!client) return;

  // Publish offline status before disconnecting
  const willTopic = `wc4/${homeId}/status/bridge`;
  publish(willTopic, { online: false, ts: new Date().toISOString() }, { retain: true });

  return new Promise((resolve) => {
    client.end(false, {}, () => {
      connected = false;
      console.log("[mqtt] Disconnected gracefully");
      resolve();
    });
  });
}

/**
 * Get uptime in seconds.
 */
function getUptime() {
  return Math.floor((Date.now() - startTime) / 1000);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseJSON(buffer) {
  try {
    return JSON.parse(buffer.toString());
  } catch {
    return buffer.toString();
  }
}

function topicMatchesPattern(topic, pattern) {
  const topicParts = topic.split("/");
  const patternParts = pattern.split("/");

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] === "#") return true;
    if (patternParts[i] === "+") continue;
    if (patternParts[i] !== topicParts[i]) return false;
  }

  return topicParts.length === patternParts.length;
}

/**
 * Register a callback to be invoked when the broker connection is re-established.
 */
function onReconnect(listener) {
  reconnectListeners.add(listener);
  return () => reconnectListeners.delete(listener);
}

module.exports = {
  connect,
  publish,
  subscribe,
  unsubscribe,
  disconnect,
  isConnected,
  onReconnect,
  getHomeId,
  getUptime,
};
