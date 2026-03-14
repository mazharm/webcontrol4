// ---------------------------------------------------------------------------
// mqtt/state-publisher.js – Bridges internal state to MQTT
// ---------------------------------------------------------------------------
// Listens to StateMachine stateChange events and publishes full device state
// payloads to MQTT. Also publishes heartbeat, home state, scenes, routines.
// ---------------------------------------------------------------------------

const mqttClient = require("./mqtt-client");
const { deviceToMqttPayload, ringCameraToMqttPayload, ringAlarmToMqttPayload, ringSensorToMqttPayload, goveeSensorToMqttPayload } = require("./device-map");

let heartbeatTimer = null;

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

  // -------------------------------------------------------------------------
  // 1. Publish full state snapshot on startup (skip if no controller yet)
  // -------------------------------------------------------------------------
  if (stateMachine) {
    publishAllDevices(stateMachine, homeId);
    publishHomeState(stateMachine, homeId);
  }
  if (getRoutines) publishRoutineList(getRoutines, homeId);
  if (getScenes) publishScenes(getScenes, homeId);
  publishRingDevices(ring, homeId);
  if (goveeInstance) publishGoveeDevices(goveeInstance, homeId);

  // -------------------------------------------------------------------------
  // 2. Listen for Control4 state changes (skip if no controller yet)
  // -------------------------------------------------------------------------
  if (!stateMachine) {
    console.log("[mqtt-state] No stateMachine — skipping state change listener (MQTT connected before controller)");
  } else stateMachine.on("stateChange", (change) => {
    const device = stateMachine.getDeviceState(change.itemId);
    if (!device) return;

    const payload = deviceToMqttPayload(device);
    const topic = `wc4/${homeId}/state/control4/${change.itemId}`;
    mqttClient.publish(topic, payload, { retain: true });

    // Also publish updated home state
    publishHomeState(stateMachine, homeId);
  });

  // -------------------------------------------------------------------------
  // 3. Heartbeat every 30 seconds
  // -------------------------------------------------------------------------
  publishHeartbeat(homeId);
  heartbeatTimer = setInterval(() => {
    publishHeartbeat(homeId);
  }, 30_000);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

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
    const topic = `wc4/${homeId}/state/control4/${itemId}`;
    mqttClient.publish(topic, payload, { retain: true });
    count++;
  }
  console.log(`[mqtt-state] Published ${count} Control4 devices`);
}

/**
 * Publish Ring devices (cameras, sensors, alarm).
 */
async function publishRingDevices(ring, homeId) {
  try {
    const status = ring.getStatus();
    if (!status.connected) return;

    const cameras = await ring.getCameras().catch(() => []);
    for (const cam of cameras) {
      const payload = ringCameraToMqttPayload(cam);
      const topic = `wc4/${homeId}/state/ring/${cam.id}`;
      mqttClient.publish(topic, payload, { retain: true });
    }

    const devices = await ring.getDevices().catch(() => []);
    for (const sensor of devices) {
      const payload = ringSensorToMqttPayload(sensor);
      const devId = sensor.zid || sensor.id;
      const topic = `wc4/${homeId}/state/ring/${devId}`;
      mqttClient.publish(topic, payload, { retain: true });
    }

    try {
      const alarm = await ring.getAlarmMode();
      if (alarm && alarm.mode) {
        const payload = ringAlarmToMqttPayload(alarm.mode);
        mqttClient.publish(`wc4/${homeId}/state/ring/alarm`, payload, { retain: true });
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
      const topic = `wc4/${homeId}/state/govee/${sensor.id}`;
      mqttClient.publish(topic, payload, { retain: true });
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
  mqttClient.publish(`wc4/${homeId}/state/home`, payload, { retain: true });
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
  mqttClient.publish(`wc4/${homeId}/state/routines/list`, list, { retain: true });
  console.log(`[mqtt-state] Published ${list.length} routines`);
}

/**
 * Publish available scenes.
 */
async function publishScenes(getScenes, homeId) {
  try {
    const scenes = await getScenes();
    if (scenes && scenes.length > 0) {
      mqttClient.publish(`wc4/${homeId}/state/scenes`, scenes, { retain: true });
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
 * Clean up timers.
 */
function stop() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
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
