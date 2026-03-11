import type { Routine } from "../types/devices";

export async function getRoutines(): Promise<Routine[]> {
  const res = await fetch("/api/routines");
  if (!res.ok) throw new Error("Failed to fetch routines");
  return res.json();
}

export async function saveRoutine(routine: Routine): Promise<Routine> {
  const res = await fetch("/api/routines", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(routine),
  });
  if (!res.ok) throw new Error("Failed to save routine");
  return res.json();
}

export async function deleteRoutine(id: string): Promise<void> {
  const res = await fetch(`/api/routines/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete routine");
}
