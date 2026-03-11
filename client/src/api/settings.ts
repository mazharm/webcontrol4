import type { SettingsResponse } from "../types/api";

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
