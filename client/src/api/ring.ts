import type { RingCamera, RingSensor, RingStatusResponse } from "../types/api";
import { safeJson } from "./safeJson";

export async function getRingStatus(): Promise<RingStatusResponse> {
  const res = await fetch("/ring/status");
  if (!res.ok) throw new Error("Failed to get Ring status");
  return safeJson<RingStatusResponse>(res, "Failed to get Ring status");
}

export async function ringLogin({
  email,
  password,
  refreshToken,
}: {
  email?: string;
  password?: string;
  refreshToken?: string;
}): Promise<{ success: boolean; requires2FA?: boolean; prompt?: string; error?: string; locationCount?: number }> {
  const res = await fetch("/ring/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, refreshToken }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Ring login failed");
  return data;
}

export async function ringVerify(code: string): Promise<{ success: boolean; requires2FA?: boolean; prompt?: string; error?: string; locationCount?: number }> {
  const res = await fetch("/ring/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Ring verification failed");
  return data;
}

export async function getAlarmMode(): Promise<{ mode: string }> {
  const res = await fetch("/ring/alarm/mode");
  if (!res.ok) throw new Error("Failed to get alarm mode");
  return safeJson<{ mode: string }>(res, "Failed to get alarm mode");
}

export async function setAlarmMode(mode: string): Promise<{ mode: string }> {
  const res = await fetch("/ring/alarm/mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error("Failed to set alarm mode");
  return safeJson<{ mode: string }>(res, "Failed to set alarm mode");
}

export async function getCameras(): Promise<RingCamera[]> {
  const res = await fetch("/ring/cameras");
  if (!res.ok) throw new Error("Failed to get cameras");
  return safeJson<RingCamera[]>(res, "Failed to get cameras");
}

export async function getSensors(): Promise<RingSensor[]> {
  const res = await fetch("/ring/sensors");
  if (!res.ok) throw new Error("Failed to get sensors");
  return safeJson<RingSensor[]>(res, "Failed to get sensors");
}

export function getSnapshotUrl(cameraId: string): string {
  return `/ring/cameras/${encodeURIComponent(cameraId)}/snapshot`;
}

export async function toggleCameraLight(cameraId: string, on: boolean): Promise<void> {
  const res = await fetch(`/ring/cameras/${encodeURIComponent(cameraId)}/light`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ on }),
  });
  if (!res.ok) throw new Error("Failed to toggle camera light");
}

export async function toggleCameraSiren(cameraId: string, on: boolean): Promise<void> {
  const res = await fetch(`/ring/cameras/${encodeURIComponent(cameraId)}/siren`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ on }),
  });
  if (!res.ok) throw new Error("Failed to toggle camera siren");
}
