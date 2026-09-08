// ---------------------------------------------------------------------------
// mqtt/state-publisher.js – Bridges internal state to MQTT
// ---------------------------------------------------------------------------
// Listens to StateMachine stateChange events and publishes full device state
// payloads to MQTT. Also publishes heartbeat, home state, scenes, routines.
// ---------------------------------------------------------------------------

const mqttClient = require("./mqtt-client");
const { deviceToMqttPayload, ringCameraToMqttPayload, ringAlarmToMqttPayload, ringSensorToMqttPayload, goveeSensorToMqttPayload } = require("./device-map");

let heartbeatTimer = null;
let unsubReconnect = null;
let stateChangeHandler = null;
let homeStateChangeHandler = null;
let currentStateMachine = null;
const retainedCache = new Map();

/**
 * Initialize the state publisher.
 *
 * @param {object} opts
 * @param {object} opts.stateMachine    - StateMachine instance
 * @param {object} opts.ring            - ring-client module
 * @param {object} [opts.goveeInstance] - GoveeLeak instance (optional)
 * @param {function} [opts.getRoutines] - () => routinesStore array
 * @param {function} [opts.getScenes]   - async () => scenes array (optional)
 */
function init({ stateMachine, ring, goveeInstance, getRoutines, getScenes }) {
  const homeId = mqttClient.getHomeId();
  if (stateChangeHandler && currentStateMachine) {
    stop(currentStateMachine);
  }
  currentStateMachine = stateMachine || null;
  retainedCache.clear();

  // -------------------------------------------------------------------------
  // 1. Publish full state snapshot on startup (skip if no controller yet)
  // -------------------------------------------------------------------------
  if (stateMachine) {
    publishAllDevices(stateMachine, homeId);
    publishHomeState(stateMachine, homeId);
  }
  if (getRoutines) publishRoutineList(getRoutines, homeId);
  if (getScenes) publishScenes(getScenes, homeId);
  publishRingDevices(ring, homeId).catch((err) => console.warn("[mqtt-state] Failed initial Ring publish:", err.message));
  if (goveeInstance) publishGoveeDevices(goveeInstance, homeId);

  // -------------------------------------------------------------------------
  // 2. Listen for Control4 state changes (skip if no controller yet)
  // -------------------------------------------------------------------------
  if (!stateMachine) {
    console.log("[mqtt-state] No stateMachine — skipping state change listener (MQTT connected before controller)");
  } else {
    stateChangeHandler = (change) => {
      const device = stateMachine.getDeviceState(change.itemId);
      if (!device) return;

      const payload = deviceToMqttPayload(device);
      const topic = `wc4/${homeId}/state/control4/${safeSegment(change.itemId, "Control4 device ID")}`;
      publishRetainedIfChanged(topic, payload);

    };
    stateMachine.on("stateChange", stateChangeHandler);
    homeStateChangeHandler = () => publishHomeState(stateMachine, homeId);
    stateMachine.on("homeStateChange", homeStateChangeHandler);
  }

  // -------------------------------------------------------------------------
  // 3. Heartbeat every 30 seconds
  // -------------------------------------------------------------------------
  publishHeartbeat(homeId);
  heartbeatTimer = setInterval(() => {
    publishHeartbeat(homeId);
  }, 30_000);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  // -------------------------------------------------------------------------
  // 4. Re-publish all retained state after broker reconnect
  // -------------------------------------------------------------------------
  if (unsubReconnect) unsubReconnect();
  unsubReconnect = mqttClient.onReconnect(() => {
    console.log("[mqtt-state] Broker reconnected — re-publishing all state");
    retainedCache.clear();
    if (stateMachine) {
      publishAllDevices(stateMachine, homeId);
      publishHomeState(stateMachine, homeId);
    }
    if (getRoutines) publishRoutineList(getRoutines, homeId);
    if (getScenes) publishScenes(getScenes, homeId);
    publishRingDevices(ring, homeId, { force: true }).catch((err) => console.warn("[mqtt-state] Failed reconnect Ring publish:", err.message));
    if (goveeInstance) publishGoveeDevices(goveeInstance, homeId);
    publishHeartbeat(homeId);
  });

  // -------------------------------------------------------------------------
  // 5. Clean up stale retained messages from previous server instances
  // -------------------------------------------------------------------------
  cleanupStaleRetained(homeId, { stateMachine, ring, goveeInstance })
    .catch((err) => console.warn("[mqtt-state] Retained cleanup failed:", err.message));

  console.log("[mqtt-state] State publisher initialized");
}

/**
 * Publish all Control4 devices as retained messages.
 */
function publishAllDevices(stateMachine, homeId) {
  const devices = stateMachine.getAllDeviceStates();
  let count = 0;
  for (const [itemId, device] of devices) {
    const payload = deviceToMqttPayload(device);
    const topic = `wc4/${homeId}/state/control4/${safeSegment(itemId, "Control4 device ID")}`;
    publishRetainedIfChanged(topic, payload);
    count++;
  }
  console.log(`[mqtt-state] Published ${count} Control4 devices`);
}

/**
 * Publish Ring devices (cameras, sensors, alarm).
 */
async function publishRingDevices(ring, homeId, options = {}) {
  try {
    const status = ring.getStatus();
    if (!status.connected) return;

    const cameras = await ring.getCameras().catch(() => []);
    for (const cam of cameras) {
      const payload = ringCameraToMqttPayload(cam);
      const topic = `wc4/${homeId}/state/ring/${safeSegment(cam.id, "Ring camera ID")}`;
      publishRetainedIfChanged(topic, payload, options);
    }

    const devices = await ring.getDevices().catch(() => []);
    for (const sensor of devices) {
      const payload = ringSensorToMqttPayload(sensor);
      const devId = sensor.zid || sensor.id;
      const topic = `wc4/${homeId}/state/ring/${safeSegment(devId, "Ring device ID")}`;
      publishRetainedIfChanged(topic, payload, options);
    }

    try {
      const alarm = await ring.getAlarmMode();
      if (alarm && alarm.mode) {
        const payload = ringAlarmToMqttPayload(alarm.mode);
        publishRetainedIfChanged(`wc4/${homeId}/state/ring/alarm`, payload, options);
      }
    } catch {
      // alarm not available
    }

    console.log(`[mqtt-state] Published Ring devices`);
  } catch (err) {
    console.warn("[mqtt-state] Failed to publish Ring devices:", err.message);
  }
}

/**
 * Publish Govee leak sensor devices.
 */
function publishGoveeDevices(goveeInstance, homeId) {
  try {
    const state = goveeInstance.getState();
    if (!state || !state.sensors) return;

    for (const sensor of state.sensors) {
      const payload = goveeSensorToMqttPayload(sensor);
      const topic = `wc4/${homeId}/state/govee/${safeSegment(sensor.id, "Govee sensor ID")}`;
      publishRetainedIfChanged(topic, payload);
    }
    console.log(`[mqtt-state] Published ${state.sensors.length} Govee sensors`);
  } catch (err) {
    console.warn("[mqtt-state] Failed to publish Govee devices:", err.message);
  }
}

/**
 * Publish home state (mode, alerts, occupancy).
 */
function publishHomeState(stateMachine, homeId) {
  const homeState = stateMachine.getHomeState();
  const payload = {
    mode: homeState.mode,
    confidence: homeState.confidence,
    occupiedRooms: homeState.occupiedRooms || [],
    alerts: (homeState.alerts || []).map((a) => ({
      id: `${a.type}-${a.deviceId}-${a.timestamp}`,
      type: a.type,
      message: a.message,
      deviceId: String(a.deviceId),
      deviceName: stateMachine.getDeviceState(a.deviceId)?.name || "",
      timestamp: a.timestamp,
    })),
    ts: new Date().toISOString(),
  };
  publishRetainedIfChanged(`wc4/${homeId}/state/home`, payload);
}

/**
 * Publish the routine list as a retained message.
 */
function publishRoutineList(getRoutines, homeId) {
  const routines = getRoutines();
  const list = routines.map((r) => ({
    id: r.id,
    name: r.name,
    steps: r.steps.length,
    hasSchedule: !!(r.schedule && r.schedule.enabled),
    hasConditions: !!(r.conditions && r.conditions.length > 0 && r.conditionsEnabled),
  }));
  publishRetainedIfChanged(`wc4/${homeId}/state/routines/list`, list);
  console.log(`[mqtt-state] Published ${list.length} routines`);
}

/**
 * Publish available scenes.
 */
async function publishScenes(getScenes, homeId) {
  try {
    const scenes = await getScenes();
    if (scenes && scenes.length > 0) {
      publishRetainedIfChanged(`wc4/${homeId}/state/scenes`, scenes);
      console.log(`[mqtt-state] Published ${scenes.length} scenes`);
    }
  } catch {
    // scenes not available
  }
}

/**
 * Publish bridge heartbeat.
 */
function publishHeartbeat(homeId) {
  mqttClient.publish(`wc4/${homeId}/status/bridge`, {
    online: true,
    uptime: mqttClient.getUptime(),
    ts: new Date().toISOString(),
  }, { retain: true });
}

/**
 * Notify the publisher that Govee state has changed.
 */
function onGoveeUpdate(goveeInstance) {
  const homeId = mqttClient.getHomeId();
  publishGoveeDevices(goveeInstance, homeId);
}

/**
 * Notify the publisher that routines have changed.
 */
function onRoutinesChanged(getRoutines) {
  const homeId = mqttClient.getHomeId();
  publishRoutineList(getRoutines, homeId);
}

/**
 * Remove stale retained messages left by a previous server instance.
 * Subscribes to the state wildcard, waits for retained messages, then clears
 * any device topics that don't belong to the current state.
 */
async function cleanupStaleRetained(homeId, { stateMachine, ring, goveeInstance }) {
  const validTopics = new Set();

  // Collect current Control4 device topics
  if (stateMachine) {
    for (const [itemId] of stateMachine.getAllDeviceStates()) {
      validTopics.add(`wc4/${homeId}/state/control4/${safeSegment(itemId, "Control4 device ID")}`);
    }
  }

  // Collect current Ring device topics
  try {
    if (ring.getStatus().connected) {
      const cameras = await ring.getCameras().catch(() => []);
      for (const cam of cameras) validTopics.add(`wc4/${homeId}/state/ring/${safeSegment(cam.id, "Ring camera ID")}`);
      const devices = await ring.getDevices().catch(() => []);
      for (const s of devices) validTopics.add(`wc4/${homeId}/state/ring/${safeSegment(s.zid || s.id, "Ring device ID")}`);
      validTopics.add(`wc4/${homeId}/state/ring/alarm`);
    }
  } catch { /* ignore */ }

  // Collect current Govee device topics
  if (goveeInstance) {
    try {
      const state = goveeInstance.getState();
      if (state && state.sensors) {
        for (const s of state.sensors) validTopics.add(`wc4/${homeId}/state/govee/${safeSegment(s.id, "Govee sensor ID")}`);
      }
    } catch { /* ignore */ }
  }

  // Subscribe to wildcard and collect stale device topics
  const staleTopics = [];
  const devicePrefixes = [
    `wc4/${homeId}/state/control4/`,
    `wc4/${homeId}/state/ring/`,
    `wc4/${homeId}/state/govee/`,
  ];

  const handler = (_payload, topic) => {
    const isDeviceTopic = devicePrefixes.some((p) => topic.startsWith(p));
    if (isDeviceTopic && !validTopics.has(topic)) {
      staleTopics.push(topic);
    }
  };

  mqttClient.subscribe(`wc4/${homeId}/state/#`, handler);

  // Wait for retained messages to arrive from the broker
  await delay(3000);

  mqttClient.unsubscribe(`wc4/${homeId}/state/#`, handler);

  // Re-collect valid topics to account for devices added during the wait window
  if (stateMachine) {
    for (const [itemId] of stateMachine.getAllDeviceStates()) {
      validTopics.add(`wc4/${homeId}/state/control4/${safeSegment(itemId, "Control4 device ID")}`);
    }
  }

  // Clear stale retained messages (empty payload + retain = delete)
  const confirmedStale = staleTopics.filter((t) => !validTopics.has(t));
  for (const topic of confirmedStale) {
    mqttClient.publish(topic, "", { retain: true });
    retainedCache.delete(topic);
  }

  if (confirmedStale.length > 0) {
    console.log(`[mqtt-state] Cleared ${confirmedStale.length} stale retained messages`);
  }
}

/**
 * Clean up timers.
 */
function stop(stateMachine) {
  if (stateChangeHandler && stateMachine) {
    stateMachine.removeListener("stateChange", stateChangeHandler);
    stateChangeHandler = null;
  }
  if (homeStateChangeHandler && stateMachine) {
    stateMachine.removeListener("homeStateChange", homeStateChangeHandler);
    homeStateChangeHandler = null;
  }
  if (unsubReconnect) {
    unsubReconnect();
    unsubReconnect = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  currentStateMachine = null;
}

function publishRetainedIfChanged(topic, payload, options = {}) {
  const cacheKey = stableStateString(payload);
  if (!options.force && retainedCache.get(topic) === cacheKey) return false;
  retainedCache.set(topic, cacheKey);
  return mqttClient.publish(topic, payload, { retain: true });
}

function stableStateString(value) {
  return JSON.stringify(stripVolatileFields(value));
}

function stripVolatileFields(value) {
  if (Array.isArray(value)) return value.map(stripVolatileFields);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, childValue] of Object.entries(value)) {
    if (key === "ts") continue;
    out[key] = stripVolatileFields(childValue);
  }
  return out;
}

function safeSegment(value, label) {
  return mqttClient.safeTopicSegment(value, label);
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
  });
}

module.exports = {
  init,
  onGoveeUpdate,
  onRoutinesChanged,
  publishAllDevices,
  publishRingDevices,
  publishGoveeDevices,
  publishHomeState,
  publishRoutineList,
  stop,
};
