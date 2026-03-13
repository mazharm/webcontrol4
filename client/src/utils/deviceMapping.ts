import type { UnifiedDevice, LightState, ThermostatState, LockState, SensorState, CameraState, SecurityState, MediaState, Scene } from "../types/devices";
import type { C4LightItem, C4ThermostatItem, C4Variable, C4SceneItem, RingCamera, RingSensor, StateSnapshot } from "../types/api";

function synthesizeRoomId(roomName: string, floorName: string): number | null {
  const room = roomName.trim();
  const floor = floorName.trim();
  if (!room && !floor) return null;

  const key = `${floor}\u0000${room}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash * 31) + key.charCodeAt(i)) | 0;
  }
  if (hash === 0) hash = 1;
  return -Math.abs(hash);
}

function normalizeRoomId(roomId: number | null | undefined, roomName: string, floorName: string): number | null {
  if (Number.isFinite(roomId) && Number(roomId) > 0) return Number(roomId);
  return synthesizeRoomId(roomName, floorName);
}

function isLightOnValue(value: unknown): boolean {
  return value === 1 || value === "1" || value === true || value === "true" || value === "on" || value === "On";
}

export function mapC4Light(item: C4LightItem, vars: Record<string, string>): UnifiedDevice {
  const level = parseInt(String(vars["LIGHT_LEVEL"] ?? "0"), 10) || 0;
  const roomName = item.roomName || "Unknown";
  const floorName = item.floorName || "Unknown";
  const state: LightState = {
    type: "light",
    on: level > 0 || isLightOnValue(vars["LIGHT_STATE"]),
    level,
  };
  return {
    id: `control4:${item.id}`,
    source: "control4",
    type: "light",
    name: item.name,
    roomId: normalizeRoomId(item.roomParentId, roomName, floorName),
    roomName,
    floorName,
    zoneName: null,
    state,
    lastUpdated: Date.now(),
  };
}

export function mapC4Thermostat(item: C4ThermostatItem, vars: Record<string, string>): UnifiedDevice {
  const roomName = item.roomName || "Unknown";
  const floorName = item.floorName || "Unknown";
  const state: ThermostatState = {
    type: "thermostat",
    currentTempF: parseFloat(vars["TEMPERATURE_F"] || "0"),
    heatSetpointF: parseFloat(vars["HEAT_SETPOINT_F"] || "68"),
    coolSetpointF: parseFloat(vars["COOL_SETPOINT_F"] || "74"),
    hvacMode: (vars["HVAC_MODE"] as ThermostatState["hvacMode"]) || "Off",
    hvacState: vars["HVAC_STATE"] || "Idle",
    humidity: parseFloat(vars["HUMIDITY"] || "0"),
    fanMode: vars["FAN_MODE"] || "Auto",
  };
  return {
    id: `control4:${item.id}`,
    source: "control4",
    type: "thermostat",
    name: item.name,
    roomId: normalizeRoomId(item.roomParentId, roomName, floorName),
    roomName,
    floorName,
    zoneName: null,
    state,
    lastUpdated: Date.now(),
  };
}

export function mapC4Lock(itemId: number, name: string, room: string, roomId: number, floor: string, vars: Record<string, string>): UnifiedDevice {
  const roomName = room || "Unknown";
  const floorName = floor || "Unknown";
  const state: LockState = {
    type: "lock",
    locked: vars["LOCK_STATE"] === "locked" || vars["LOCK_STATE"] === "1",
    lastAction: vars["LAST_ACTION"] || "",
    batteryLevel: parseInt(vars["BATTERY_LEVEL"] || "100", 10),
  };
  return {
    id: `control4:${itemId}`,
    source: "control4",
    type: "lock",
    name,
    roomId: normalizeRoomId(roomId, roomName, floorName),
    roomName,
    floorName,
    zoneName: null,
    state,
    lastUpdated: Date.now(),
  };
}

export function mapC4Sensor(itemId: number, name: string, room: string, roomId: number, floor: string, vars: Record<string, string>): UnifiedDevice {
  const roomName = room || "Unknown";
  const floorName = floor || "Unknown";
  const hasMotion = "MOTION_STATE" in vars || "MOTION_DETECTED" in vars;
  const hasContact = "CONTACT_STATE" in vars;
  const sensorKind = hasMotion ? "motion" : hasContact ? "contact" : "contact";
  const triggered = hasMotion
    ? vars["MOTION_STATE"] === "1" || vars["MOTION_DETECTED"] === "1"
    : vars["CONTACT_STATE"] === "1" || vars["CONTACT_STATE"] === "Open";
  const state: SensorState = {
    type: "sensor",
    sensorKind: sensorKind as SensorState["sensorKind"],
    triggered,
    lastTriggered: triggered ? Date.now() : null,
    batteryLevel: vars["BATTERY_LEVEL"] ? parseInt(vars["BATTERY_LEVEL"], 10) : undefined,
  };
  return {
    id: `control4:${itemId}`,
    source: "control4",
    type: "sensor",
    name,
    roomId: normalizeRoomId(roomId, roomName, floorName),
    roomName,
    floorName,
    zoneName: null,
    state,
    lastUpdated: Date.now(),
  };
}

export function mapC4Media(itemId: number, name: string, room: string, roomId: number, floor: string, vars: Record<string, string>): UnifiedDevice {
  const roomName = room || "Unknown";
  const floorName = floor || "Unknown";
  const state: MediaState = {
    type: "media",
    powerOn: vars["POWER_STATE"] === "1" || vars["POWER_STATE"] === "On",
    currentMedia: vars["CURRENT_MEDIA_INFO"] || "",
    volume: parseInt(vars["CURRENT_VOLUME"] || "0", 10),
  };
  return {
    id: `control4:${itemId}`,
    source: "control4",
    type: "media",
    name,
    roomId: normalizeRoomId(roomId, roomName, floorName),
    roomName,
    floorName,
    zoneName: null,
    state,
    lastUpdated: Date.now(),
  };
}

export function mapC4Security(itemId: number, name: string, room: string, roomId: number, floor: string, vars: Record<string, string>): UnifiedDevice {
  const roomName = room || "Unknown";
  const floorName = floor || "Unknown";
  let mode: SecurityState["mode"] = "disarmed";
  const ps = (vars["PARTITION_STATE"] || "").toLowerCase();
  if (ps.includes("away")) mode = "away";
  else if (ps.includes("home") || ps.includes("stay")) mode = "home";
  const state: SecurityState = {
    type: "security",
    mode,
    partitionState: vars["PARTITION_STATE"] || "",
    alarmType: vars["ALARM_TYPE"] || "",
  };
  return {
    id: `control4:${itemId}`,
    source: "control4",
    type: "security",
    name,
    roomId: normalizeRoomId(roomId, roomName, floorName),
    roomName,
    floorName,
    zoneName: null,
    state,
    lastUpdated: Date.now(),
  };
}

export function mapRingCamera(cam: RingCamera, roomMapping?: number): UnifiedDevice {
  const state: CameraState = {
    type: "camera",
    online: !cam.isOffline,
    hasLight: cam.hasLight ?? false,
    lightOn: false,
    hasSiren: cam.hasSiren ?? false,
    sirenOn: false,
    snapshotUrl: `/ring/cameras/${cam.id}/snapshot`,
  };
  return {
    id: `ring:${cam.id}`,
    source: "ring",
    type: "camera",
    name: cam.name || `Camera ${cam.id}`,
    roomId: roomMapping ?? null,
    roomName: roomMapping ? "" : "Outdoor",
    floorName: roomMapping ? "" : "",
    zoneName: roomMapping ? null : "Outdoor",
    state,
    lastUpdated: Date.now(),
  };
}

export function mapRingSensor(sensor: RingSensor, roomMapping?: number): UnifiedDevice {
  const sensorType = sensor.type?.toLowerCase() || "";
  const kind = sensorType.includes("motion") ? "motion" : "contact";
  const state: SensorState = {
    type: "sensor",
    sensorKind: kind as SensorState["sensorKind"],
    triggered: sensor.faulted,
    lastTriggered: sensor.faulted ? Date.now() : null,
    batteryLevel: sensor.batteryLevel,
  };
  return {
    id: `ring:${sensor.zid}`,
    source: "ring",
    type: "sensor",
    name: sensor.name,
    roomId: roomMapping ?? null,
    roomName: roomMapping ? "" : "Outdoor",
    floorName: roomMapping ? "" : "",
    zoneName: roomMapping ? null : "Outdoor",
    state,
    lastUpdated: Date.now(),
  };
}

export function mapC4Scene(item: C4SceneItem): Scene {
  return {
    id: item.id,
    name: item.name,
    roomId: item.roomParentId,
    roomName: item.roomName,
  };
}

/** Map state machine snapshot devices into UnifiedDevice[] */
export function mapStateDevices(snapshot: StateSnapshot): UnifiedDevice[] {
  const devices: UnifiedDevice[] = [];
  for (const [, dev] of Object.entries(snapshot.devices)) {
    const vars = dev.variables || {};
    switch (dev.type) {
      case "light":
        devices.push(mapC4Light(
          { id: dev.itemId, name: dev.name, type: 7, roomName: dev.room, roomParentId: dev.roomId, floorName: dev.floor },
          vars
        ));
        break;
      case "thermostat":
        devices.push(mapC4Thermostat(
          { id: dev.itemId, name: dev.name, type: 7, roomName: dev.room, roomParentId: dev.roomId, floorName: dev.floor },
          vars
        ));
        break;
      case "lock":
        devices.push(mapC4Lock(dev.itemId, dev.name, dev.room, dev.roomId, dev.floor, vars));
        break;
      case "sensor":
        devices.push(mapC4Sensor(dev.itemId, dev.name, dev.room, dev.roomId, dev.floor, vars));
        break;
      case "security":
        devices.push(mapC4Security(dev.itemId, dev.name, dev.room, dev.roomId, dev.floor, vars));
        break;
      case "media":
        devices.push(mapC4Media(dev.itemId, dev.name, dev.room, dev.roomId, dev.floor, vars));
        break;
    }
  }
  return devices;
}
