export interface DirectorOptions {
  ip: string;
  token: string;
}

interface RealtimeConnectOptions extends DirectorOptions {
  accountToken?: string;
  controllerCommonName?: string;
}

async function waitForStateReady(timeoutMs = 5000, pollMs = 250) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snapshot = await getState();
    const deviceCount = snapshot?.deviceCount ?? Object.keys(snapshot?.devices || {}).length;
    if (deviceCount > 0) return snapshot;
    await new Promise((resolve) => window.setTimeout(resolve, pollMs));
  }
  throw new Error("Controller connected but device state did not populate");
}

function directorHeaders(opts: DirectorOptions): HeadersInit {
  return {
    "X-Director-IP": opts.ip,
    "X-Director-Token": opts.token,
    "Content-Type": "application/json",
  };
}

export async function getLights(opts: DirectorOptions) {
  const res = await fetch("/api/director/api/v1/categories/lights", {
    headers: directorHeaders(opts),
  });
  if (!res.ok) throw new Error("Failed to fetch lights");
  return res.json();
}

export async function getThermostats(opts: DirectorOptions) {
  const res = await fetch("/api/director/api/v1/categories/thermostats", {
    headers: directorHeaders(opts),
  });
  if (!res.ok) throw new Error("Failed to fetch thermostats");
  return res.json();
}

export async function getScenes(opts: DirectorOptions) {
  const res = await fetch("/api/director/api/v1/categories/scenes", {
    headers: directorHeaders(opts),
  });
  if (!res.ok) throw new Error("Failed to fetch scenes");
  return res.json();
}

export async function getItemVariables(opts: DirectorOptions, itemId: number) {
  const res = await fetch(`/api/director/api/v1/items/${itemId}/variables`, {
    headers: directorHeaders(opts),
  });
  if (!res.ok) throw new Error(`Failed to fetch variables for item ${itemId}`);
  return res.json();
}

export async function sendCommand(opts: DirectorOptions, itemId: number, command: string, tParams: Record<string, unknown> = {}) {
  const res = await fetch(`/api/director/api/v1/items/${itemId}/commands`, {
    method: "POST",
    headers: directorHeaders(opts),
    body: JSON.stringify({ command, tParams }),
  });
  if (!res.ok) throw new Error(`Command failed: ${command}`);
  return res.json();
}

export async function connectRealtime(opts: RealtimeConnectOptions) {
  const res = await fetch("/api/realtime/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      controllerIp: opts.ip,
      directorToken: opts.token,
      accountToken: opts.accountToken,
      controllerCommonName: opts.controllerCommonName,
    }),
  });
  if (!res.ok) throw new Error("Failed to connect realtime");
  const result = await res.json();
  await waitForStateReady();
  return result;
}

export async function getState() {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error("Failed to fetch state");
  return res.json();
}

export async function getRoomState(roomId: number) {
  const res = await fetch(`/api/state/room/${roomId}`);
  if (!res.ok) throw new Error("Failed to fetch room state");
  return res.json();
}
