import type { AuthLoginResponse, AuthControllersResponse, AuthDirectorTokenResponse, AuthStatusResponse } from "../types/api";

export async function login(username: string, password: string): Promise<AuthLoginResponse> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.statusText}`);
  return res.json();
}

export async function getControllers(accountToken: string): Promise<AuthControllersResponse> {
  const res = await fetch("/api/auth/controllers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountToken }),
  });
  if (!res.ok) throw new Error(`Failed to get controllers: ${res.statusText}`);
  const data = await res.json();
  // Backend returns array directly, normalize to { controllers: [...] }
  const list = Array.isArray(data) ? data : data.controllers || data.account || [];
  return {
    controllers: list.map((c: Record<string, string>) => ({
      commonName: c.controllerCommonName || c.commonName || "",
      name: c.name || c.controllerCommonName || "",
      address: c.localIP || c.address || "",
    })),
  };
}

export async function getDirectorToken(accountToken: string, controllerCommonName: string): Promise<AuthDirectorTokenResponse> {
  const res = await fetch("/api/auth/director-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountToken, controllerCommonName }),
  });
  if (!res.ok) throw new Error(`Failed to get director token: ${res.statusText}`);
  return res.json();
}

export async function getAuthStatus(): Promise<AuthStatusResponse> {
  const res = await fetch("/auth/status");
  if (!res.ok) throw new Error(`Auth status check failed: ${res.statusText}`);
  return res.json();
}

export async function discoverControllers(timeoutMs = 5000): Promise<Array<{ host: string; ip: string }>> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("/api/discover", { signal: controller.signal });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data)
      ? data.map((entry: Record<string, string>) => ({
          host: entry["host-name"] || entry.host || "",
          ip: entry.ip || "",
        }))
      : [];
  } catch {
    return [];
  } finally {
    window.clearTimeout(timeout);
  }
}

export function googleAuthUrl(): string {
  return "/auth/google";
}
