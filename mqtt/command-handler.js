// ---------------------------------------------------------------------------
// mqtt/command-handler.js – Routes MQTT commands to adapters
// ---------------------------------------------------------------------------
// Subscribes to command topics and dispatches to the appropriate adapter
// (Control4 Director, Ring, routines).
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const mqttClient = require("./mqtt-client");

let executeScheduledCommand = null;
let executeRoutineSteps = null;
let ringModule = null;
let routinesFile = null;
let stateMachine = null;

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

  // Reject commands without timestamp (replay protection)
  if (!payload || !payload.ts) {
    console.warn(`[mqtt-cmd] Rejected command without timestamp: ${topic}`);
    return;
  }
  const age = Date.now() - new Date(payload.ts).getTime();
  if (age > 30_000 || age < -5_000) {
    console.warn(`[mqtt-cmd] Rejected stale command (age=${Math.round(age / 1000)}s): ${topic}`);
    return;
  }

  const remainder = topic.slice(prefix.length); // e.g. "control4/42/set" or "routines/morning/execute"
  const parts = remainder.split("/");

  try {
    // Route: cmd/routines/{routineId}/execute
    if (parts[0] === "routines" && parts[2] === "execute") {
      const routineId = parts[1];
      await handleRoutineExecute(routineId, homeId);
      return;
    }

    // Route: cmd/{system}/{deviceId}/{action}
    if (parts.length >= 3) {
      const system = parts[0];
      const deviceId = parts[1];
      const action = parts[2];

      if (system === "control4" && action === "set") {
        await handleControl4Command(deviceId, payload);
      } else if (system === "ring" && action === "set") {
        await handleRingCommand(deviceId, payload);
      }
    }
  } catch (err) {
    console.error(`[mqtt-cmd] Command failed (${topic}):`, err.message);
  }
}

/**
 * Handle a Control4 device command.
 */
async function handleControl4Command(deviceId, payload) {
  if (!executeScheduledCommand) {
    throw new Error("executeScheduledCommand not available");
  }

  const itemId = parseInt(deviceId, 10);
  if (!Number.isFinite(itemId)) {
    throw new Error(`Invalid Control4 device ID: ${deviceId}`);
  }

  // Map MQTT command fields to Director commands.
  // Apply state change optimistically BEFORE sending to Director so that
  // SSE listeners (local web client) update instantly.
  if (payload.level !== undefined) {
    const level = Number(payload.level);
    if (!Number.isFinite(level) || level < 0 || level > 100) {
      throw new Error(`Invalid light level: ${payload.level}`);
    }
    applyStateChange(itemId, "LIGHT_STATE", level > 0 ? "1" : "0");
    applyStateChange(itemId, "LIGHT_LEVEL", String(level));
    await executeScheduledCommand(itemId, "SET_LEVEL", { LEVEL: level });
  }
  if (payload.on !== undefined) {
    if (typeof payload.on !== "boolean") {
      throw new Error(`Invalid on value: ${payload.on}`);
    }
    const level = payload.on ? 100 : 0;
    applyStateChange(itemId, "LIGHT_STATE", payload.on ? "1" : "0");
    applyStateChange(itemId, "LIGHT_LEVEL", String(level));
    await executeScheduledCommand(itemId, "SET_LEVEL", { LEVEL: level });
  }
  if (payload.hvacMode !== undefined) {
    const allowedModes = ["Off", "Heat", "Cool", "Auto"];
    if (!allowedModes.includes(payload.hvacMode)) {
      throw new Error(`Invalid hvacMode: ${payload.hvacMode}`);
    }
    applyStateChange(itemId, "HVAC_MODE", String(payload.hvacMode));
    await executeScheduledCommand(itemId, "SET_MODE_HVAC", { MODE: payload.hvacMode });
  }
  if (payload.heatSetpointF !== undefined) {
    const temp = Number(payload.heatSetpointF);
    if (!Number.isFinite(temp) || temp < 32 || temp > 120) {
      throw new Error(`Invalid heatSetpointF: ${payload.heatSetpointF}`);
    }
    applyStateChange(itemId, "HEAT_SETPOINT_F", String(temp));
    await executeScheduledCommand(itemId, "SET_SETPOINT_HEAT", { FAHRENHEIT: temp });
  }
  if (payload.coolSetpointF !== undefined) {
    const temp = Number(payload.coolSetpointF);
    if (!Number.isFinite(temp) || temp < 32 || temp > 120) {
      throw new Error(`Invalid coolSetpointF: ${payload.coolSetpointF}`);
    }
    applyStateChange(itemId, "COOL_SETPOINT_F", String(temp));
    await executeScheduledCommand(itemId, "SET_SETPOINT_COOL", { FAHRENHEIT: temp });
  }
  if (payload.fanMode !== undefined) {
    const allowedFanModes = ["Auto", "Low", "Medium", "High", "On", "Off"];
    if (typeof payload.fanMode !== "string" || payload.fanMode.length > 20) {
      throw new Error(`Invalid fanMode: ${payload.fanMode}`);
    }
    applyStateChange(itemId, "FAN_MODE", String(payload.fanMode));
    await executeScheduledCommand(itemId, "SET_FAN_MODE", { MODE: payload.fanMode });
  }

  console.log(`[mqtt-cmd] Control4 command executed: device=${itemId}`);
}

/**
 * Handle a Ring device command.
 */
async function handleRingCommand(deviceId, payload) {
  if (!ringModule) {
    throw new Error("Ring module not available");
  }

  if (deviceId === "alarm" && payload.mode !== undefined) {
    const validModes = ["away", "home", "disarm"];
    if (!validModes.includes(payload.mode)) {
      throw new Error(`Invalid Ring alarm mode: ${payload.mode}`);
    }
    await ringModule.setAlarmMode(payload.mode);
    console.log(`[mqtt-cmd] Ring alarm mode set to: ${payload.mode}`);
    return;
  }

  // Camera light toggle
  if (payload.light !== undefined && ringModule.setCameraLight) {
    await ringModule.setCameraLight(Number(deviceId), payload.light);
    console.log(`[mqtt-cmd] Ring camera ${deviceId} light: ${payload.light}`);
  }

  // Camera siren toggle
  if (payload.siren !== undefined && ringModule.setCameraSiren) {
    await ringModule.setCameraSiren(Number(deviceId), payload.siren);
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
 * Immediately apply a state change to the StateMachine so that SSE listeners
 * (local web client) and MQTT state publishers (remote client) are notified
 * without waiting for the Control4 WebSocket round-trip.
 */
function applyStateChange(itemId, varName, value) {
  if (!stateMachine) {
    console.warn(`[mqtt-cmd] applyStateChange: stateMachine is NULL, skipping`);
    return;
  }
  console.log(`[mqtt-cmd] applyStateChange: itemId=${itemId}, varName=${varName}, value=${value}`);
  try {
    stateMachine.handleDeviceEvent({ itemId, varName, value });
    console.log(`[mqtt-cmd] applyStateChange: handleDeviceEvent completed`);
  } catch (err) {
    console.error(`[mqtt-cmd] applyStateChange failed: ${err.message}`);
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

module.exports = { init };
