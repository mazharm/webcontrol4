// ---------------------------------------------------------------------------
// services/device-commands.ts – Transport-aware command dispatcher
// ---------------------------------------------------------------------------

import { isRemoteMode, getMqttConfig } from "../config/transport";
import { publish } from "./mqtt-client";
import { rpcCall } from "./mqtt-rpc";
import { sendCommand, type DirectorOptions } from "../api/director";

const MQTT_TOPIC_SEGMENT_RE = /^[A-Za-z0-9._:-]+$/;
const CONTROL4_COMMAND_FIELDS = [
  "level", "on", "hvacMode", "heatSetpointF", "coolSetpointF",
  "fanMode", "locked", "power", "activate", "volume",
] as const;
const RING_COMMAND_FIELDS = ["mode", "light", "siren"] as const;

function assertSafeTopicSegment(value: string | number, label: string): string {
  const segment = String(value);
  if (!MQTT_TOPIC_SEGMENT_RE.test(segment)) {
    throw new Error(`Invalid MQTT ${label}.`);
  }
  return segment;
}

function assertSingleCommandField(system: "control4" | "ring" | "govee", command: Record<string, unknown>): string {
  const supportedFields = system === "control4"
    ? CONTROL4_COMMAND_FIELDS
    : system === "ring"
      ? RING_COMMAND_FIELDS
      : [];
  const fields = supportedFields.filter((field) => command[field] !== undefined);
  if (fields.length !== 1) {
    throw new Error(`${system} command must contain exactly one supported command field.`);
  }
  return fields[0];
}

/**
 * Send a device command via the appropriate transport.
 * In local mode: calls REST API via director.ts
 * In mqtt mode: publishes to MQTT command topic
 */
export async function sendDeviceCommand(
  system: "control4" | "ring" | "govee",
  deviceId: string | number,
  command: Record<string, unknown>,
  directorOpts?: DirectorOptions,
): Promise<void> {
  const commandField = assertSingleCommandField(system, command);
  if (isRemoteMode()) {
    const safeDeviceId = assertSafeTopicSegment(deviceId, "device id");
    await rpcCall("deviceCommand", { system, deviceId: safeDeviceId, command }, 40_000);
  } else {
    // Local mode — use existing REST API
    if (system === "control4") {
      if (!directorOpts) throw new Error("Director connection is not available.");
      const itemId = typeof deviceId === "string" ? parseInt(deviceId, 10) : deviceId;
      // Map the command fields to Director API format
      if (commandField === "level") {
        await sendCommand(directorOpts, itemId, "SET_LEVEL", { LEVEL: command.level });
      }
      if (commandField === "on") {
        await sendCommand(directorOpts, itemId, "SET_LEVEL", { LEVEL: command.on ? 100 : 0 });
      }
      if (commandField === "hvacMode") {
        await sendCommand(directorOpts, itemId, "SET_MODE_HVAC", { MODE: command.hvacMode });
      }
      if (commandField === "heatSetpointF") {
        await sendCommand(directorOpts, itemId, "SET_SETPOINT_HEAT", { FAHRENHEIT: command.heatSetpointF });
      }
      if (commandField === "coolSetpointF") {
        await sendCommand(directorOpts, itemId, "SET_SETPOINT_COOL", { FAHRENHEIT: command.coolSetpointF });
      }
      if (commandField === "fanMode") {
        await sendCommand(directorOpts, itemId, "SET_FAN_MODE", { MODE: command.fanMode });
      }
      if (commandField === "locked") {
        await sendCommand(directorOpts, itemId, command.locked ? "LOCK" : "UNLOCK");
      }
      if (commandField === "power") {
        await sendCommand(directorOpts, itemId, command.power ? "ON" : "OFF");
      }
      if (commandField === "activate") {
        await sendCommand(directorOpts, itemId, "ACTIVATE");
      }
      if (commandField === "volume") {
        await sendCommand(directorOpts, itemId, "SET_VOLUME_LEVEL", { LEVEL: command.volume });
      }
    } else if (system === "ring") {
      const endpoint = commandField === "mode"
        ? "/ring/alarm/mode"
        : `/ring/cameras/${encodeURIComponent(String(deviceId))}/${commandField}`;
      const body = commandField === "mode"
        ? { mode: command.mode }
        : { on: command[commandField] };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Failed to execute Ring ${commandField} command: ${res.statusText}`);
    }
  }
}

/**
 * Execute a routine by ID (mqtt mode only).
 */
export function executeRoutine(routineId: string): void {
  if (!isRemoteMode()) return;
  const config = getMqttConfig();
  const safeRoutineId = assertSafeTopicSegment(routineId, "routine id");
  const topic = `wc4/${config.homeId}/cmd/routines/${safeRoutineId}/execute`;
  publish(topic, { ts: new Date().toISOString() });
}
