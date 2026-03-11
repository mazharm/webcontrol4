import type { HistoryPoint } from "../types/api";

export async function getHistory(type: "light" | "thermo" | "floor", id: string | number): Promise<HistoryPoint[]> {
  const res = await fetch(`/api/history?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error("Failed to fetch history");
  return res.json();
}

export async function recordHistory(ip: string, token: string): Promise<void> {
  const res = await fetch("/api/history/record", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Director-IP": ip,
      "X-Director-Token": token,
    },
  });
  if (!res.ok) throw new Error("Failed to record history");
}
