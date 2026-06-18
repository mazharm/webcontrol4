// ---------------------------------------------------------------------------
// mqtt/mqtt-client.js – Core MQTT connection manager
// ---------------------------------------------------------------------------
// Connects to HiveMQ Cloud (or any MQTT broker) over mqtts://.
// Provides publish/subscribe wrappers with automatic reconnection and LWT.
// ---------------------------------------------------------------------------

const mqtt = require("mqtt");
const crypto = require("crypto");

let client = null;
let homeId = "";
let connected = false;
const startTime = Date.now();
const subscriptions = new Map(); // topic -> Set<handler>
const reconnectListeners = new Set(); // callbacks invoked after broker reconnect
let messageSecret = "";
const replayCache = new Map(); // signature -> first seen timestamp
const REPLAY_TTL_MS = 2 * 60 * 1000;
const MAX_REPLAY_CACHE = 2000;
const MAX_INBOUND_BYTES = 512 * 1024;
const BASE_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;

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
function connect({ brokerUrl, username, password, homeId: hid, messageSecret: msgSecret }) {
  return new Promise((resolve, reject) => {
    if (client) {
      try { client.end(true); } catch {}
      client = null;
      connected = false;
      subscriptions.clear();
      reconnectListeners.clear();
      replayCache.clear();
    }

    const parsedBroker = new URL(brokerUrl);
    if (!["mqtts:", "wss:", "mqtt:", "ws:"].includes(parsedBroker.protocol)) {
      return reject(new Error(`Unsupported MQTT broker protocol: ${parsedBroker.protocol}`));
    }

    homeId = safeTopicSegment(hid, "homeId");
    // Message signing is OPT-IN: only enforced when an explicit signing secret
    // is configured (MQTT_MESSAGE_SECRET / MQTT_COMMAND_SECRET).  It is NOT
    // derived from the broker password, because the browser client publishes
    // unsigned commands — defaulting signing on would reject all remote control.
    messageSecret = String(msgSecret || "");
    let settled = false;
    let reconnectAttempt = 0;

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
      reconnectAttempt = 0;
      // Enable auto-reconnect now that we know credentials are valid
      client.options.reconnectPeriod = BASE_RECONNECT_MS;
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
      reconnectAttempt++;
      const delay = Math.min(MAX_RECONNECT_MS, BASE_RECONNECT_MS * (2 ** Math.min(reconnectAttempt, 5)));
      client.options.reconnectPeriod = delay;
      console.log(`[mqtt] Reconnecting (attempt ${reconnectAttempt}, next delay ${delay}ms)...`);
    });

    client.on("close", () => {
      connected = false;
      if (!settled) {
        settled = true;
        reject(new Error("MQTT connection closed before connect"));
      }
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
      if (payload.length > MAX_INBOUND_BYTES) {
        console.warn(`[mqtt] Dropping oversized inbound message on ${topic}: ${payload.length} bytes`);
        return;
      }
      const parsed = safeParseJSON(payload);

      // Check exact match first
      const handlers = subscriptions.get(topic);
      if (handlers) {
        for (const handler of handlers) {
          invokeHandler(handler, parsed, topic);
        }
      }

      // Check wildcard matches
      for (const [pattern, patternHandlers] of subscriptions) {
        if (pattern === topic) continue; // already handled
        if (topicMatchesPattern(topic, pattern)) {
          for (const handler of patternHandlers) {
            invokeHandler(handler, parsed, topic);
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
    return false;
  }
  if (!isValidPublishTopic(topic)) {
    console.warn(`[mqtt] Refusing to publish invalid topic: ${topic}`);
    return false;
  }
  let message;
  try {
    message = typeof payload === "string" ? payload : JSON.stringify(payload);
  } catch (err) {
    console.error("[mqtt] Cannot publish unserializable payload:", err.message);
    return false;
  }
  client.publish(topic, message, {
    qos: options.qos ?? 1,
    retain: options.retain ?? false,
  }, (err) => {
    if (err) console.error("[mqtt] Publish failed:", err.message);
  });
  return true;
}

/**
 * Subscribe to a topic with a handler.
 * @param {string} topic   - supports MQTT wildcards (+ and #)
 * @param {function} handler - receives (parsedPayload, topic)
 */
function subscribe(topic, handler) {
  if (!isValidSubscriptionTopic(topic)) {
    throw new Error(`Invalid MQTT subscription topic: ${topic}`);
  }
  if (typeof handler !== "function") {
    throw new Error("MQTT subscription handler must be a function");
  }
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

  const activeClient = client;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      connected = false;
      if (client === activeClient) client = null;
      subscriptions.clear();
      reconnectListeners.clear();
      replayCache.clear();
      resolve();
    }, 5000);
    if (timer.unref) timer.unref();
    activeClient.end(false, {}, () => {
      clearTimeout(timer);
      connected = false;
      if (client === activeClient) client = null;
      subscriptions.clear();
      reconnectListeners.clear();
      replayCache.clear();
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

function invokeHandler(handler, payload, topic) {
  try {
    const result = handler(payload, topic);
    if (result && typeof result.then === "function") {
      result.catch((err) => console.error("[mqtt] Handler error:", err.message));
    }
  } catch (err) {
    console.error("[mqtt] Handler error:", err.message);
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

function isValidPublishTopic(topic) {
  if (typeof topic !== "string" || topic.length === 0 || topic.length > 512) return false;
  if (topic.includes("#") || topic.includes("+") || topic.includes("\0")) return false;
  return topic.split("/").every((part) => part.length > 0);
}

function isValidSubscriptionTopic(topic) {
  if (typeof topic !== "string" || topic.length === 0 || topic.length > 512 || topic.includes("\0")) return false;
  const parts = topic.split("/");
  if (parts.some((part) => part.length === 0)) return false;
  return parts.every((part, index) => {
    if (part === "#") return index === parts.length - 1;
    if (part.includes("#")) return false;
    if (part.includes("+")) return part === "+";
    return true;
  });
}

function safeTopicSegment(value, name = "topic segment") {
  const segment = String(value || "").trim();
  if (!isSafeTopicSegment(segment)) {
    throw new Error(`Invalid MQTT ${name}: ${segment}`);
  }
  return segment;
}

function isSafeTopicSegment(segment) {
  return typeof segment === "string"
    && segment.length > 0
    && segment.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(segment);
}

function verifySignedPayload(payload, topic) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "payload must be a JSON object" };
  }
  if (!messageSecret) {
    return { ok: false, reason: "message signing secret not configured" };
  }

  const supplied = typeof payload.sig === "string" ? payload.sig : payload.signature;
  const suppliedHex = String(supplied || "").replace(/^sha256=/i, "");
  if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) {
    return { ok: false, reason: "missing or invalid signature" };
  }

  const signedPayload = stripSignature(payload);
  const canonical = canonicalStringify(signedPayload);
  const expectedHex = crypto
    .createHmac("sha256", messageSecret)
    .update(`${topic}\n${canonical}`)
    .digest("hex");

  const suppliedBuf = Buffer.from(suppliedHex, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");
  if (!crypto.timingSafeEqual(suppliedBuf, expectedBuf)) {
    return { ok: false, reason: "signature mismatch" };
  }

  pruneReplayCache();
  if (replayCache.has(suppliedHex)) {
    return { ok: false, reason: "duplicate signed message" };
  }
  replayCache.set(suppliedHex, Date.now());
  return { ok: true };
}

function stripSignature(value) {
  if (Array.isArray(value)) return value.map(stripSignature);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "sig" || key === "signature") continue;
    out[key] = stripSignature(value[key]);
  }
  return out;
}

function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(",")}}`;
}

function pruneReplayCache() {
  const now = Date.now();
  for (const [sig, ts] of replayCache) {
    if (now - ts > REPLAY_TTL_MS || replayCache.size > MAX_REPLAY_CACHE) {
      replayCache.delete(sig);
    }
  }
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
  isSafeTopicSegment,
  safeTopicSegment,
  verifySignedPayload,
  isSigningEnabled: () => !!messageSecret,
};
