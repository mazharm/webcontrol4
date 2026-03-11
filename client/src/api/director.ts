interface DirectorOptions {
  ip: string;
  token: string;
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

export async function connectRealtime(opts: DirectorOptions) {
  const res = await fetch("/api/realtime/connect", {
    method: "POST",
    headers: directorHeaders(opts),
  });
  if (!res.ok) throw new Error("Failed to connect realtime");
  return res.json();
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
