import type { SettingsResponse, GoveeLoginResponse, GoveeLeakStatus } from "../types/api";
import { safeJson } from "./safeJson";

export async function getSettings(): Promise<SettingsResponse> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error("Failed to fetch settings");
  return safeJson<SettingsResponse>(res, "Failed to fetch settings");
}

export async function saveSettings(settings: { anthropicKey?: string; anthropicModel?: string; deviceMappings?: Record<string, number> }): Promise<SettingsResponse> {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error("Failed to save settings");
  return safeJson<SettingsResponse>(res, "Failed to save settings");
}

export async function goveeLogin(email: string, password: string): Promise<GoveeLoginResponse> {
  const res = await fetch("/api/govee/leak/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Govee login failed");
  }
  return safeJson<GoveeLoginResponse>(res, "Govee login failed");
}

export async function goveeDisconnect(): Promise<void> {
  const res = await fetch("/api/govee/leak/disconnect", { method: "POST" });
  if (!res.ok) throw new Error("Failed to disconnect Govee");
}

export async function getGoveeLeakStatus(): Promise<GoveeLeakStatus> {
  const res = await fetch("/api/govee/leak/status");
  if (!res.ok) throw new Error("Failed to fetch Govee status");
  return safeJson<GoveeLeakStatus>(res, "Failed to fetch Govee status");
}

export async function saveGoveeSensorRooms(mapping: Record<string, string>): Promise<void> {
  const res = await fetch("/api/govee/leak/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rooms: mapping }),
  });
  if (!res.ok) throw new Error("Failed to save sensor rooms");
}

export async function mqttConnect(config: {
  brokerUrl: string;
  username: string;
  password: string;
  homeId?: string;
}): Promise<{ ok: boolean; connected: boolean }> {
  const res = await fetch("/api/mqtt/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "MQTT connection failed");
  }
  return safeJson<{ ok: boolean; connected: boolean }>(res, "MQTT connection failed");
}

export async function mqttDisconnect(): Promise<void> {
  const res = await fetch("/api/mqtt/disconnect", { method: "POST" });
  if (!res.ok) throw new Error("Failed to disconnect MQTT");
}
