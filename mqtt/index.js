// ---------------------------------------------------------------------------
// mqtt/index.js – MQTT module entry point
// ---------------------------------------------------------------------------
// Orchestrates MQTT connection, state publishing, command handling, and RPC.
// Called from server.js — only if MQTT_BROKER_URL env var is set.
// ---------------------------------------------------------------------------

const mqttClient = require("./mqtt-client");
const statePublisher = require("./state-publisher");
const commandHandler = require("./command-handler");
const rpcHandler = require("./rpc-handler");

/**
 * Initialize the entire MQTT module.
 *
 * @param {object} opts
 * @param {object} opts.stateMachine          - StateMachine instance
 * @param {object} opts.ring                  - ring-client module
 * @param {object} [opts.goveeInstance]        - GoveeLeak instance
 * @param {object} [opts.trending]             - TrendingEngine instance
 * @param {function} opts.executeScheduledCommand - (deviceId, command, tParams) => Promise
 * @param {function} opts.executeRoutineSteps     - (routine) => Promise
 * @param {string}   opts.routinesFile            - path to data/routines.json
 * @param {function} [opts.getRoutines]            - () => routines array
 * @param {function} [opts.getScenes]              - async () => scenes array
 * @returns {Promise<object>} - { onGoveeUpdate, onRoutinesChanged, disconnect }
 */
async function init(opts) {
  const brokerUrl = opts.brokerUrl || process.env.MQTT_BROKER_URL;
  const username = opts.username || process.env.MQTT_USERNAME;
  const password = opts.password || process.env.MQTT_PASSWORD;
  const homeId = opts.homeId || process.env.MQTT_HOME_ID || "home1";

  if (!brokerUrl) {
    throw new Error("MQTT_BROKER_URL is required");
  }
  if (!username || !password) {
    throw new Error("MQTT_USERNAME and MQTT_PASSWORD are required");
  }

  console.log(`[mqtt] Connecting to ${brokerUrl} (home: ${homeId})...`);

  await mqttClient.connect({ brokerUrl, username, password, homeId });

  // Initialize sub-modules
  statePublisher.init({
    stateMachine: opts.stateMachine,
    ring: opts.ring,
    goveeInstance: opts.goveeInstance,
    getRoutines: opts.getRoutines,
    getScenes: opts.getScenes,
  });

  commandHandler.init({
    executeScheduledCommand: opts.executeScheduledCommand,
    executeRoutineSteps: opts.executeRoutineSteps,
    ring: opts.ring,
    routinesFile: opts.routinesFile,
    stateMachine: opts.stateMachine,
  });

  rpcHandler.init({
    ring: opts.ring,
    trending: opts.trending,
    handleLlmChat: opts.handleLlmChat,
    getHistoryStore: opts.getHistoryStore,
    getRoutines: opts.getRoutines,
  });

  console.log("[mqtt] All modules initialized");

  return {
    onGoveeUpdate: () => statePublisher.onGoveeUpdate(opts.goveeInstance),
    onRoutinesChanged: () => statePublisher.onRoutinesChanged(opts.getRoutines),
    disconnect: async () => {
      statePublisher.stop();
      await mqttClient.disconnect();
    },
  };
}

module.exports = { init };
