// ---------------------------------------------------------------------------
// mqtt/rpc-handler.js – Handles request/response RPC over MQTT
// ---------------------------------------------------------------------------
// Subscribes to rpc/request topic, dispatches by method, responds on
// rpc/response/{requestId}. Supports camera snapshots, trending, history.
// ---------------------------------------------------------------------------

const mqttClient = require("./mqtt-client");

const RPC_TIMEOUT_MS = 10_000;
const LLM_TIMEOUT_MS = 60_000; // LLM calls can take longer
const MAX_RESPONSE_BYTES = 256 * 1024; // HiveMQ free tier limit

let ringModule = null;
let trendingEngine = null;
let llmChatFn = null;
let historyStoreFn = null;
let getRoutinesFn = null;

/**
 * Initialize the RPC handler.
 *
 * @param {object} opts
 * @param {object} opts.ring     - ring-client module
 * @param {object} [opts.trending] - TrendingEngine instance (optional)
 * @param {function} [opts.handleLlmChat] - async (body) => result (optional)
 */
function init({ ring, trending, handleLlmChat, getHistoryStore, getRoutines }) {
  ringModule = ring;
  trendingEngine = trending;
  llmChatFn = handleLlmChat || null;
  historyStoreFn = getHistoryStore || null;
  getRoutinesFn = getRoutines || null;

  const homeId = mqttClient.getHomeId();
  mqttClient.subscribe(`wc4/${homeId}/rpc/request`, handleRpcRequest);

  console.log("[mqtt-rpc] RPC handler initialized");
}

/**
 * Handle an incoming RPC request.
 */
async function handleRpcRequest(payload, topic) {
  const homeId = mqttClient.getHomeId();
  const { id, method, params, ts } = payload || {};

  if (!id || !method) {
    console.warn("[mqtt-rpc] Invalid RPC request: missing id or method");
    return;
  }

  // Replay protection: require timestamp, reject stale/future messages
  if (!ts) {
    console.warn(`[mqtt-rpc] Rejected RPC without timestamp: ${method}`);
    return;
  }
  const age = Date.now() - new Date(ts).getTime();
  if (age > 30_000 || age < -5_000) {
    console.warn(`[mqtt-rpc] Rejected stale RPC (age=${Math.round(age / 1000)}s): ${method}`);
    return;
  }

  const responseTopic = `wc4/${homeId}/rpc/response/${id}`;

  let responded = false;
  function respond(payload) {
    if (responded) return;
    responded = true;
    mqttClient.publish(responseTopic, payload);
  }

  // Use longer timeout for LLM calls
  const timeoutMs = method === "llmChat" ? LLM_TIMEOUT_MS : RPC_TIMEOUT_MS;
  const timer = setTimeout(() => {
    respond({ id, error: "RPC timeout — request took too long" });
  }, timeoutMs);

  try {
    let result;

    switch (method) {
      case "getSnapshot":
        result = await handleGetSnapshot(params);
        break;
      case "getTrending":
        result = await handleGetTrending(params);
        break;
      case "getHistory":
        result = await handleGetHistory(params);
        break;
      case "getDailySummary":
        result = await handleGetDailySummary(params);
        break;
      case "getAppHistory":
        result = handleGetAppHistory(params);
        break;
      case "getRoutines":
        result = handleGetRoutines();
        break;
      case "llmChat":
        result = await handleLlmChat(params);
        break;
      default:
        clearTimeout(timer);
        respond({ id, error: `Unknown method: ${method}` });
        return;
    }

    clearTimeout(timer);

    // Check response size (skip for snapshots — they're inherently large)
    const responseStr = JSON.stringify({ id, result });
    if (method !== "getSnapshot" && responseStr.length > MAX_RESPONSE_BYTES) {
      respond({
        id,
        error: `Response too large (${Math.round(responseStr.length / 1024)}KB > ${MAX_RESPONSE_BYTES / 1024}KB limit)`,
      });
      return;
    }
    if (responseStr.length > MAX_RESPONSE_BYTES) {
      console.warn(`[mqtt-rpc] Large response for ${method}: ${Math.round(responseStr.length / 1024)}KB`);
    }

    respond({ id, result });
  } catch (err) {
    clearTimeout(timer);
    respond({ id, error: err.message });
    console.error(`[mqtt-rpc] RPC ${method} failed:`, err.message);
  }
}

/**
 * Get a camera snapshot as base64 JPEG.
 */
async function handleGetSnapshot(params) {
  if (!ringModule) throw new Error("Ring module not available");
  const { cameraId } = params || {};
  if (!cameraId) throw new Error("cameraId is required");

  // Ring camera IDs are numbers
  const numericId = Number(cameraId);
  if (!Number.isFinite(numericId)) throw new Error(`Invalid cameraId: ${cameraId}`);

  const buffer = await ringModule.getCameraSnapshot(numericId);
  if (!buffer) throw new Error(`No snapshot available for camera ${cameraId}`);

  const base64 = buffer.toString("base64");
  return {
    image: `data:image/jpeg;base64,${base64}`,
    cameraId: String(numericId),
    ts: new Date().toISOString(),
  };
}

/**
 * Get trending data for a device.
 */
async function handleGetTrending(params) {
  if (!trendingEngine) throw new Error("Trending engine not available");
  const { deviceId, variable, days } = params || {};
  if (!deviceId) throw new Error("deviceId is required");

  if (variable) {
    const trend = trendingEngine.getDeviceTrend(Number(deviceId), variable, days || 14);
    return { deviceId, variable, points: trend, ts: new Date().toISOString() };
  }

  const history = trendingEngine.getDeviceHistory(Number(deviceId), (days || 1) * 24);
  return { deviceId, events: history, ts: new Date().toISOString() };
}

/**
 * Get device event history.
 */
async function handleGetHistory(params) {
  if (!trendingEngine) throw new Error("Trending engine not available");
  const { deviceId, hours, limit } = params || {};
  if (!deviceId) throw new Error("deviceId is required");

  const events = trendingEngine.getDeviceHistory(Number(deviceId), hours || 24);
  const limited = limit ? events.slice(0, limit) : events;
  return { deviceId, events: limited, ts: new Date().toISOString() };
}

/**
 * Get daily summary for a device.
 */
async function handleGetDailySummary(params) {
  if (!trendingEngine) throw new Error("Trending engine not available");
  const { deviceId, days } = params || {};
  if (!deviceId) throw new Error("deviceId is required");

  const summary = trendingEngine.getDailySummary(Number(deviceId), days || 7);
  return { deviceId, summary, ts: new Date().toISOString() };
}

/**
 * Get app-level history data (same format as GET /api/history).
 */
function handleGetAppHistory(params) {
  if (!historyStoreFn) throw new Error("History store not available");
  const { type, id } = params || {};
  if (!type || !id) throw new Error("type and id are required");
  const allowedTypes = ["light", "thermo", "floor"];
  if (!allowedTypes.includes(type)) throw new Error("type must be one of: light, thermo, floor");
  const safeId = String(id).replace(/[^a-zA-Z0-9 _\-]/g, "").slice(0, 128);
  if (!safeId) throw new Error("invalid id");
  return historyStoreFn(`${type}:${safeId}`);
}

/**
 * Get all routines with full step details.
 */
function handleGetRoutines() {
  if (!getRoutinesFn) throw new Error("Routines not available");
  const routines = getRoutinesFn();
  return Array.isArray(routines) ? routines : [];
}

/**
 * Broker an LLM chat request to the server's handleLlmChat function.
 */
async function handleLlmChat(params) {
  if (!llmChatFn) throw new Error("LLM chat not available");
  const { message, messages, context, mode } = params || {};
  // Size limit on LLM input to prevent API credit abuse
  const inputStr = JSON.stringify({ message, messages, context });
  if (inputStr.length > 10000) {
    throw new Error(`LLM input too large (${inputStr.length} chars, max 10000)`);
  }
  return llmChatFn({ message, messages, context, mode });
}

module.exports = { init };
