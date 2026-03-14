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

/**
 * Initialize the command handler.
 *
 * @param {object} opts
 * @param {function} opts.executeScheduledCommand - (deviceId, command, tParams) => Promise
 * @param {function} opts.executeRoutineSteps     - (routine) => Promise
 * @param {object}   opts.ring                    - ring-client module
 * @param {string}   opts.routinesFile            - path to data/routines.json
 */
function init({ executeScheduledCommand: execCmd, executeRoutineSteps: execRoutine, ring, routinesFile: rf }) {
  executeScheduledCommand = execCmd;
  executeRoutineSteps = execRoutine;
  ringModule = ring;
  routinesFile = rf;

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

  // Map MQTT command fields to Director commands
  if (payload.level !== undefined) {
    await executeScheduledCommand(itemId, "SET_LEVEL", { LEVEL: payload.level });
  }
  if (payload.on !== undefined) {
    await executeScheduledCommand(itemId, "SET_LEVEL", { LEVEL: payload.on ? 100 : 0 });
  }
  if (payload.hvacMode !== undefined) {
    await executeScheduledCommand(itemId, "SET_MODE_HVAC", { MODE: payload.hvacMode });
  }
  if (payload.heatSetpointF !== undefined) {
    await executeScheduledCommand(itemId, "SET_SETPOINT_HEAT", { FAHRENHEIT: payload.heatSetpointF });
  }
  if (payload.coolSetpointF !== undefined) {
    await executeScheduledCommand(itemId, "SET_SETPOINT_COOL", { FAHRENHEIT: payload.coolSetpointF });
  }
  if (payload.fanMode !== undefined) {
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
