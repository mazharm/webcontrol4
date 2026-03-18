// ---------------------------------------------------------------------------
// mqtt/device-map.js – Maps internal device IDs to MQTT-friendly identifiers
// ---------------------------------------------------------------------------
// Auto-generates device map from StateMachine discovery. Uses the device's
// internal itemId for Control4, and adapter-specific IDs for Ring/Govee.
// ---------------------------------------------------------------------------

/**
 * Build a device map from the StateMachine's discovered devices.
 * Returns a Map of MQTT device_id -> device metadata.
 *
 * @param {Map<number, object>} devices - StateMachine._devices (itemId -> device)
 * @returns {{ byMqttId: Map<string, object>, byItemId: Map<number, string> }}
 */
function buildDeviceMap(devices) {
  const byMqttId = new Map();  // mqttDeviceId -> { itemId, system, type, name, room, roomId, floor }
  const byItemId = new Map();  // itemId -> mqttDeviceId

  for (const [itemId, device] of devices) {
    const mqttId = String(itemId);
    byMqttId.set(mqttId, {
      itemId,
      system: "control4",
      type: device.type,
      name: device.name,
      room: device.room,
      roomId: device.roomId,
      floor: device.floor,
    });
    byItemId.set(itemId, mqttId);
  }

  return { byMqttId, byItemId };
}

/**
 * Convert a StateMachine device object into an MqttDevicePayload.
 *
 * @param {object} device - StateMachine device (with variables)
 * @returns {object} MqttDevicePayload
 */
function deviceToMqttPayload(device) {
  const state = buildDeviceState(device);
  return {
    id: `control4:${device.itemId}`,
    source: "control4",
    type: device.type,
    name: device.name,
    roomId: device.roomId ?? null,
    roomName: device.room || "",
    floorName: device.floor || "",
    state,
    ts: new Date().toISOString(),
  };
}

/**
 * Build the typed device state from raw Control4 variables.
 */
function buildDeviceState(device) {
  const vars = device.variables || {};

  switch (device.type) {
    case "light": {
      const level = parseInt(vars.LIGHT_LEVEL, 10) || 0;
      // Derive on from level – consistent with SSE-path logic in DeviceContext
      return { type: "light", on: level > 0, level };
    }
    case "thermostat":
      return {
        type: "thermostat",
        currentTempF: parseFloat(vars.TEMPERATURE_F) || 0,
        heatSetpointF: parseFloat(vars.HEAT_SETPOINT_F) || 68,
        coolSetpointF: parseFloat(vars.COOL_SETPOINT_F) || 74,
        hvacMode: vars.HVAC_MODE || "Off",
        hvacState: vars.HVAC_STATE || "",
        humidity: parseFloat(vars.HUMIDITY) || 0,
        fanMode: vars.FAN_MODE || "",
      };
    case "lock":
      return {
        type: "lock",
        locked: vars.LOCK_STATE === "locked" || vars.LOCK_STATE === "1",
        lastAction: vars.LAST_ACTION || "",
        batteryLevel: parseInt(vars.BATTERY_LEVEL, 10) || 0,
      };
    case "sensor": {
      const hasContact = vars.CONTACT_STATE !== undefined;
      const hasMotion = vars.MOTION_STATE !== undefined || vars.MOTION_DETECTED !== undefined;
      const sensorKind = hasContact ? "contact" : hasMotion ? "motion" : "contact";
      const triggered = hasContact
        ? (vars.CONTACT_STATE === "1" || vars.CONTACT_STATE === "Open")
        : (vars.MOTION_STATE === "1" || vars.MOTION_DETECTED === "1");
      return {
        type: "sensor",
        sensorKind,
        triggered,
        lastTriggered: triggered ? Date.now() : null,
        batteryLevel: vars.BATTERY_LEVEL ? parseInt(vars.BATTERY_LEVEL, 10) : undefined,
      };
    }
    case "security": {
      const partitionState = vars.PARTITION_STATE || "";
      const lv = partitionState.toLowerCase();
      let mode = "disarmed";
      if (lv.includes("away")) mode = "away";
      else if (lv.includes("home") || lv.includes("stay")) mode = "home";
      return {
        type: "security",
        mode,
        partitionState,
        alarmType: vars.ALARM_TYPE || "",
      };
    }
    case "media":
      return {
        type: "media",
        powerOn: vars.POWER_STATE === "1" || vars.POWER_STATE === "On",
        currentMedia: vars.CURRENT_MEDIA_INFO || "",
        volume: parseInt(vars.CURRENT_VOLUME, 10) || 0,
      };
    default:
      return { type: device.type };
  }
}

/**
 * Convert a Ring camera to an MqttDevicePayload.
 */
function ringCameraToMqttPayload(camera) {
  return {
    id: `ring:${camera.id}`,
    source: "ring",
    type: "camera",
    name: camera.name || "Ring Camera",
    roomId: null,
    roomName: "Outdoor",
    floorName: "",
    state: {
      type: "camera",
      online: !camera.isOffline,
      hasLight: camera.hasLight || false,
      lightOn: camera.lightOn || false,
      hasSiren: camera.hasSiren || false,
      sirenOn: camera.sirenOn || false,
      snapshotUrl: null,
    },
    ts: new Date().toISOString(),
  };
}

/**
 * Convert Ring alarm mode to an MqttDevicePayload.
 */
function ringAlarmToMqttPayload(alarmMode) {
  let mode = "disarmed";
  if (alarmMode === "all") mode = "away";
  else if (alarmMode === "some") mode = "home";
  return {
    id: "ring:alarm",
    source: "ring",
    type: "security",
    name: "Ring Alarm",
    roomId: null,
    roomName: "Outdoor",
    floorName: "",
    state: {
      type: "security",
      mode,
      partitionState: alarmMode || "",
      alarmType: "",
    },
    ts: new Date().toISOString(),
  };
}

/**
 * Convert a Ring sensor to an MqttDevicePayload.
 */
function ringSensorToMqttPayload(sensor) {
  return {
    id: `ring:${sensor.zid || sensor.id}`,
    source: "ring",
    type: "sensor",
    name: sensor.name || "Ring Sensor",
    roomId: null,
    roomName: sensor.roomName || "Outdoor",
    floorName: "",
    state: {
      type: "sensor",
      sensorKind: sensor.sensorKind || "contact",
      triggered: sensor.faulted || false,
      lastTriggered: sensor.faulted ? Date.now() : null,
      batteryLevel: sensor.batteryLevel,
    },
    ts: new Date().toISOString(),
  };
}

/**
 * Convert a Govee leak sensor to an MqttDevicePayload.
 */
function goveeSensorToMqttPayload(sensor) {
  return {
    id: `govee:${sensor.id}`,
    source: "govee",
    type: "sensor",
    name: sensor.name || "Govee Leak Sensor",
    roomId: null,
    roomName: "",
    floorName: "",
    state: {
      type: "sensor",
      sensorKind: "flood",
      triggered: sensor.leakDetected || false,
      lastTriggered: sensor.leakDetected ? Date.now() : null,
      batteryLevel: sensor.battery,
    },
    ts: new Date().toISOString(),
  };
}

module.exports = {
  buildDeviceMap,
  deviceToMqttPayload,
  buildDeviceState,
  ringCameraToMqttPayload,
  ringAlarmToMqttPayload,
  ringSensorToMqttPayload,
  goveeSensorToMqttPayload,
};
