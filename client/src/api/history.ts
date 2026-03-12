import type { HistoryPoint } from "../types/api";
import type { UnifiedDevice, LightState, ThermostatState } from "../types/devices";

export async function getHistory(type: "light" | "thermo" | "floor", id: string | number): Promise<HistoryPoint[]> {
  const res = await fetch(`/api/history?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error("Failed to fetch history");
  return res.json();
}

export async function recordHistory(devices: UnifiedDevice[]): Promise<void> {
  const lights = devices
    .filter((device): device is UnifiedDevice & { type: "light"; state: LightState } => device.type === "light" && device.source === "control4")
    .map((light) => ({
      id: Number(light.id.replace("control4:", "")),
      on: light.state.on,
      level: light.state.level,
      floorName: light.floorName,
    }));

  const thermostats = devices
    .filter((device): device is UnifiedDevice & { type: "thermostat"; state: ThermostatState } => device.type === "thermostat" && device.source === "control4")
    .map((thermostat) => ({
      id: Number(thermostat.id.replace("control4:", "")),
      tempF: thermostat.state.currentTempF,
      heatF: thermostat.state.heatSetpointF,
      coolF: thermostat.state.coolSetpointF,
      hvacMode: thermostat.state.hvacMode,
    }));

  const floors = lights.reduce<Record<string, number>>((acc, light) => {
    const floorName = light.floorName || "Unknown";
    if (!(floorName in acc)) acc[floorName] = 0;
    if (light.on) acc[floorName] += 1;
    return acc;
  }, {});

  const res = await fetch("/api/history/record", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lights, thermostats, floors }),
  });
  if (!res.ok) throw new Error("Failed to record history");
}
