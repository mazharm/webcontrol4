// ---------------------------------------------------------------------------
// services/device-commands.ts – Transport-aware command dispatcher
// ---------------------------------------------------------------------------

import { isRemoteMode, getMqttConfig } from "../config/transport";
import { publish } from "./mqtt-client";
import { sendCommand, type DirectorOptions } from "../api/director";

const MQTT_TOPIC_SEGMENT_RE = /^[A-Za-z0-9._:-]+$/;

function assertSafeTopicSegment(value: string | number, label: string): string {
  const segment = String(value);
  if (!MQTT_TOPIC_SEGMENT_RE.test(segment)) {
    throw new Error(`Invalid MQTT ${label}.`);
  }
  return segment;
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
  if (isRemoteMode()) {
    const config = getMqttConfig();
    const safeDeviceId = assertSafeTopicSegment(deviceId, "device id");
    const topic = `wc4/${config.homeId}/cmd/${system}/${safeDeviceId}/set`;
    const published = publish(topic, { ...command, ts: new Date().toISOString() });
    if (!published) {
      throw new Error("MQTT client is not connected");
    }
  } else {
    // Local mode — use existing REST API
    if (system === "control4" && directorOpts) {
      const itemId = typeof deviceId === "string" ? parseInt(deviceId, 10) : deviceId;
      // Map the command fields to Director API format
      if (command.level !== undefined) {
        await sendCommand(directorOpts, itemId, "SET_LEVEL", { LEVEL: command.level });
      }
      if (command.on !== undefined) {
        await sendCommand(directorOpts, itemId, "SET_LEVEL", { LEVEL: command.on ? 100 : 0 });
      }
      if (command.hvacMode !== undefined) {
        await sendCommand(directorOpts, itemId, "SET_MODE_HVAC", { MODE: command.hvacMode });
      }
      if (command.heatSetpointF !== undefined) {
        await sendCommand(directorOpts, itemId, "SET_SETPOINT_HEAT", { FAHRENHEIT: command.heatSetpointF });
      }
      if (command.coolSetpointF !== undefined) {
        await sendCommand(directorOpts, itemId, "SET_SETPOINT_COOL", { FAHRENHEIT: command.coolSetpointF });
      }
      if (command.fanMode !== undefined) {
        await sendCommand(directorOpts, itemId, "SET_FAN_MODE", { MODE: command.fanMode });
      }
    } else if (system === "ring") {
      // Ring commands in local mode go through ring API endpoints
      if (command.mode !== undefined) {
        const res = await fetch("/ring/alarm/mode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: command.mode }),
        });
        if (!res.ok) throw new Error(`Failed to set Ring alarm mode: ${res.statusText}`);
      }
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
