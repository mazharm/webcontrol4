import type { SettingsResponse, GoveeLoginResponse, GoveeLeakStatus } from "../types/api";

export async function getSettings(): Promise<SettingsResponse> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error("Failed to fetch settings");
  return res.json();
}

export async function saveSettings(settings: { anthropicKey?: string; anthropicModel?: string; deviceMappings?: Record<string, number> }): Promise<SettingsResponse> {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error("Failed to save settings");
  return res.json();
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
  return res.json();
}

export async function goveeDisconnect(): Promise<void> {
  const res = await fetch("/api/govee/leak/disconnect", { method: "POST" });
  if (!res.ok) throw new Error("Failed to disconnect Govee");
}

export async function getGoveeLeakStatus(): Promise<GoveeLeakStatus> {
  const res = await fetch("/api/govee/leak/status");
  if (!res.ok) throw new Error("Failed to fetch Govee status");
  return res.json();
}

export async function saveGoveeSensorRooms(mapping: Record<string, string>): Promise<void> {
  const res = await fetch("/api/govee/leak/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rooms: mapping }),
  });
  if (!res.ok) throw new Error("Failed to save sensor rooms");
}
