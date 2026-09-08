// ---------------------------------------------------------------------------
// mqtt/command-handler.js – Routes MQTT commands to adapters
// ---------------------------------------------------------------------------
// Subscribes to command topics and dispatches to the appropriate adapter
// (Control4 Director, Ring, routines).
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mqttClient = require("./mqtt-client");

let executeScheduledCommand = null;
let executeRoutineSteps = null;
let ringModule = null;
let routinesFile = null;
let stateMachine = null;
const commandReplayCache = new Map();
const COMMAND_REPLAY_TTL_MS = 60_000;
const COMMAND_REPLAY_MAX = 2000;

/**
 * Initialize the command handler.
 *
 * @param {object} opts
 * @param {function} opts.executeScheduledCommand - (deviceId, command, tParams) => Promise
 * @param {function} opts.executeRoutineSteps     - (routine) => Promise
 * @param {object}   opts.ring                    - ring-client module
 * @param {string}   opts.routinesFile            - path to data/routines.json
 */
function init({ executeScheduledCommand: execCmd, executeRoutineSteps: execRoutine, ring, routinesFile: rf, stateMachine: sm }) {
  executeScheduledCommand = execCmd;
  executeRoutineSteps = execRoutine;
  ringModule = ring;
  routinesFile = rf;
  stateMachine = sm;

  const homeId = mqttClient.getHomeId();

  // Subscribe to device commands
  mqttClient.subscribe(`wc4/${homeId}/cmd/#`, handleCommand);

  console.log("[mqtt-cmd] Command handler initialized");
}

/**
 * Handle an incoming MQTT command message.
 */
async function handleCommand(payload, topic) {
  const homeId = mqttClient.getHomeId();
  const prefix = `wc4/${homeId}/cmd/`;

  if (!topic.startsWith(prefix)) return;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    console.warn(`[mqtt-cmd] Rejected non-object command payload: ${topic}`);
    return;
  }

  // Signature verification is opt-in (only when a signing secret is
  // configured).  Timestamp-based replay protection below always applies, and
  // publishing to the command topic already requires authenticated broker
  // (TLS + username/password) access.
  if (mqttClient.isSigningEnabled()) {
    const auth = mqttClient.verifySignedPayload(payload, topic);
    if (!auth.ok) {
      console.warn(`[mqtt-cmd] Rejected unauthenticated command (${auth.reason}): ${topic}`);
      return;
    }
  }

  // Reject commands without timestamp (replay protection)
  if (!payload.ts) {
    console.warn(`[mqtt-cmd] Rejected command without timestamp: ${topic}`);
    return;
  }
  const ts = new Date(payload.ts).getTime();
  if (!Number.isFinite(ts)) {
    console.warn(`[mqtt-cmd] Rejected command with invalid timestamp: ${topic}`);
    return;
  }
  const age = Date.now() - ts;
  if (age > 30_000 || age < -5_000) {
    console.warn(`[mqtt-cmd] Rejected stale command (age=${Math.round(age / 1000)}s): ${topic}`);
    return;
  }
  if (isDuplicateCommand(topic, payload)) {
    console.warn(`[mqtt-cmd] Ignoring duplicate QoS command: ${topic}`);
    return;
  }

  const remainder = topic.slice(prefix.length); // e.g. "control4/42/set" or "routines/morning/execute"
  const parts = remainder.split("/");

  try {
    // Route: cmd/routines/{routineId}/execute
    if (parts.length === 3 && parts[0] === "routines" && parts[2] === "execute") {
      const routineId = parts[1];
      validateTopicSegment(routineId, "routineId");
      await handleRoutineExecute(routineId, homeId);
      return;
    }

    // Route: cmd/{system}/{deviceId}/{action}
    if (parts.length === 3) {
      const system = parts[0];
      const deviceId = parts[1];
      const action = parts[2];
      validateTopicSegment(deviceId, "deviceId");

      if (action === "set") {
        await executeDeviceCommand(system, deviceId, payload);
      }
    }
  } catch (err) {
    console.error(`[mqtt-cmd] Command failed (${topic}):`, err.message);
  }
}

function isDuplicateCommand(topic, payload) {
  const now = Date.now();
  for (const [key, seenAt] of commandReplayCache) {
    if (now - seenAt > COMMAND_REPLAY_TTL_MS || commandReplayCache.size > COMMAND_REPLAY_MAX) {
      commandReplayCache.delete(key);
    }
  }
  const digest = crypto
    .createHash("sha256")
    .update(`${topic}\n${JSON.stringify(payload)}`)
    .digest("hex");
  if (commandReplayCache.has(digest)) return true;
  commandReplayCache.set(digest, now);
  return false;
}

async function executeDeviceCommand(system, deviceId, payload) {
  validateTopicSegment(String(deviceId), "deviceId");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("command payload must be an object");
  }
  if (system === "control4") {
    await handleControl4Command(String(deviceId), payload);
    return;
  }
  if (system === "ring") {
    await handleRingCommand(String(deviceId), payload);
    return;
  }
  throw new Error(`Unsupported device system: ${system}`);
}

/**
 * Handle a Control4 device command.
 */
async function handleControl4Command(deviceId, payload) {
  if (!executeScheduledCommand) {
    throw new Error("executeScheduledCommand not available");
  }

  const itemId = parseInt(deviceId, 10);
  if (!/^\d+$/.test(deviceId) || !Number.isSafeInteger(itemId)) {
    throw new Error(`Invalid Control4 device ID: ${deviceId}`);
  }

  const deviceType = stateMachine?.getDeviceState(itemId)?.type || null;
  const operation = resolveControl4Command(payload, deviceType);
  await executeScheduledCommand(itemId, operation.command, operation.tParams);

  console.log(`[mqtt-cmd] Control4 command executed: device=${itemId}, command=${operation.command}`);
}

function resolveControl4Command(payload, deviceType) {
  const commandFields = [
    "level", "on", "hvacMode", "heatSetpointF", "coolSetpointF",
    "fanMode", "locked", "power", "activate", "volume",
  ].filter((field) => payload[field] !== undefined);
  if (commandFields.length !== 1) {
    throw new Error("Control4 command must contain exactly one supported command field");
  }

  const field = commandFields[0];
  const requireType = (expected) => {
    if (deviceType && deviceType !== expected) {
      throw new Error(`${field} is not valid for Control4 device type ${deviceType}`);
    }
  };

  if (field === "level" || field === "on") {
    requireType("light");
    const level = field === "on" ? (payload.on ? 100 : 0) : Number(payload.level);
    if (field === "on" && typeof payload.on !== "boolean") {
      throw new Error(`Invalid on value: ${payload.on}`);
    }
    if (!Number.isFinite(level) || level < 0 || level > 100) {
      throw new Error(`Invalid light level: ${payload.level}`);
    }
    return { command: "SET_LEVEL", tParams: { LEVEL: level } };
  }

  if (field === "hvacMode") {
    requireType("thermostat");
    const allowedModes = ["Off", "Heat", "Cool", "Auto"];
    if (!allowedModes.includes(payload.hvacMode)) {
      throw new Error(`Invalid hvacMode: ${payload.hvacMode}`);
    }
    return { command: "SET_MODE_HVAC", tParams: { MODE: payload.hvacMode } };
  }

  if (field === "heatSetpointF" || field === "coolSetpointF") {
    requireType("thermostat");
    const temp = Number(payload[field]);
    if (!Number.isFinite(temp) || temp < 32 || temp > 120) {
      throw new Error(`Invalid ${field}: ${payload[field]}`);
    }
    return {
      command: field === "heatSetpointF" ? "SET_SETPOINT_HEAT" : "SET_SETPOINT_COOL",
      tParams: { FAHRENHEIT: temp },
    };
  }

  if (field === "fanMode") {
    requireType("thermostat");
    const allowedFanModes = ["Auto", "Low", "Medium", "High", "On", "Off"];
    if (typeof payload.fanMode !== "string" || !allowedFanModes.includes(payload.fanMode)) {
      throw new Error(`Invalid fanMode: ${payload.fanMode}`);
    }
    return { command: "SET_FAN_MODE", tParams: { MODE: payload.fanMode } };
  }

  if (field === "locked") {
    requireType("lock");
    if (typeof payload.locked !== "boolean") throw new Error("locked must be a boolean");
    return { command: payload.locked ? "LOCK" : "UNLOCK", tParams: {} };
  }

  if (field === "power") {
    requireType("media");
    if (typeof payload.power !== "boolean") throw new Error("power must be a boolean");
    return { command: payload.power ? "ON" : "OFF", tParams: {} };
  }

  if (field === "volume") {
    requireType("media");
    const volume = Number(payload.volume);
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
      throw new Error(`Invalid volume: ${payload.volume}`);
    }
    return { command: "SET_VOLUME_LEVEL", tParams: { LEVEL: volume } };
  }

  if (deviceType) throw new Error(`activate is not valid for Control4 device type ${deviceType}`);
  if (payload.activate !== true) throw new Error("activate must be true");
  return { command: "ACTIVATE", tParams: {} };
}

/**
 * Handle a Ring device command.
 */
async function handleRingCommand(deviceId, payload) {
  if (!ringModule) {
    throw new Error("Ring module not available");
  }

  const commandFields = ["mode", "light", "siren"].filter((field) => payload[field] !== undefined);
  if (commandFields.length !== 1) {
    throw new Error("Ring command must contain exactly one supported command field");
  }

  if (deviceId === "alarm") {
    if (commandFields[0] !== "mode") throw new Error("Ring alarm only supports mode commands");
    const validModes = ["away", "home", "disarm"];
    if (!validModes.includes(payload.mode)) {
      throw new Error(`Invalid Ring alarm mode: ${payload.mode}`);
    }
    await ringModule.setAlarmMode(payload.mode);
    console.log(`[mqtt-cmd] Ring alarm mode set to: ${payload.mode}`);
    return;
  }
  if (commandFields[0] === "mode") {
    throw new Error("Ring camera devices do not support alarm mode commands");
  }

  // Camera commands require a valid numeric device ID
  const numericId = Number(deviceId);
  if (!/^\d+$/.test(deviceId) || !Number.isSafeInteger(numericId)) {
    throw new Error(`Invalid Ring device ID: ${deviceId}`);
  }

  // Camera light toggle
  if (commandFields[0] === "light") {
    if (typeof ringModule.setCameraLight !== "function") {
      throw new Error("Ring camera light control is not available");
    }
    if (typeof payload.light !== "boolean") {
      throw new Error(`Invalid light value: expected boolean, got ${typeof payload.light}`);
    }
    await ringModule.setCameraLight(numericId, payload.light);
    console.log(`[mqtt-cmd] Ring camera ${deviceId} light: ${payload.light}`);
    return;
  }

  // Camera siren toggle
  if (typeof ringModule.setCameraSiren !== "function") {
    throw new Error("Ring camera siren control is not available");
  }
  if (commandFields[0] === "siren") {
    if (typeof payload.siren !== "boolean") {
      throw new Error(`Invalid siren value: expected boolean, got ${typeof payload.siren}`);
    }
    await ringModule.setCameraSiren(numericId, payload.siren);
    console.log(`[mqtt-cmd] Ring camera ${deviceId} siren: ${payload.siren}`);
  }
}

/**
 * Handle a routine execution request.
 */
async function handleRoutineExecute(routineId, homeId) {
  if (!executeRoutineSteps) {
    throw new Error("executeRoutineSteps not available");
  }
  validateTopicSegment(routineId, "routineId");

  const routine = loadRoutineById(routineId);
  if (!routine) {
    mqttClient.publish(`wc4/${homeId}/state/routines/${routineId}/result`, {
      success: false,
      error: `Routine "${routineId}" not found`,
      ts: new Date().toISOString(),
    });
    return;
  }

  try {
    await executeRoutineSteps(routine);
    mqttClient.publish(`wc4/${homeId}/state/routines/${routineId}/result`, {
      success: true,
      routineName: routine.name,
      stepsExecuted: routine.steps.length,
      ts: new Date().toISOString(),
    });
    console.log(`[mqtt-cmd] Routine "${routine.name}" executed successfully`);
  } catch (err) {
    mqttClient.publish(`wc4/${homeId}/state/routines/${routineId}/result`, {
      success: false,
      error: err.message,
      ts: new Date().toISOString(),
    });
  }
}

/**
 * Load a routine by ID from the routines file.
 */
function loadRoutineById(routineId) {
  try {
    if (!routinesFile || !fs.existsSync(routinesFile)) return null;
    const raw = JSON.parse(fs.readFileSync(routinesFile, "utf8"));
    if (!Array.isArray(raw)) return null;
    return raw.find((r) => r.id === routineId) || null;
  } catch {
    return null;
  }
}

function validateTopicSegment(value, label) {
  if (!mqttClient.isSafeTopicSegment(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

module.exports = { init, executeDeviceCommand, resolveControl4Command, isDuplicateCommand };
