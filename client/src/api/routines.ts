import type { Routine, RoutineStep } from "../types/devices";
import { safeJson } from "./safeJson";

const ROUTINES_STORAGE_KEY = "wc4_routines";

function normalizeStep(step: RoutineStep): RoutineStep {
  if (step.type !== "light_toggle") return step;
  return { ...step, type: "light_power" };
}

function normalizeRoutine(routine: Routine): Routine {
  return {
    ...routine,
    steps: Array.isArray(routine.steps) ? routine.steps.map((step) => normalizeStep(step)) : [],
  };
}

function serializeRoutine(routine: Routine, useLegacyLightType = false): Routine {
  if (!useLegacyLightType) return normalizeRoutine(routine);
  return {
    ...routine,
    steps: Array.isArray(routine.steps)
      ? routine.steps.map((step) => (
          step.type === "light_power" ? { ...step, type: "light_toggle" } : step
        ))
      : [],
  };
}

export async function getRoutines(): Promise<Routine[]> {
  const res = await fetch("/api/routines");
  if (!res.ok) throw new Error("Failed to fetch routines");
  const routines = await safeJson<Routine[]>(res, "Failed to fetch routines").catch(() => []);
  if (Array.isArray(routines) && routines.length > 0) return routines.map((routine) => normalizeRoutine(routine));

  if (typeof window === "undefined") return Array.isArray(routines) ? routines : [];

  const local = window.localStorage.getItem(ROUTINES_STORAGE_KEY);
  if (!local) return Array.isArray(routines) ? routines.map((routine) => normalizeRoutine(routine)) : [];

  try {
    const parsed = JSON.parse(local);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return Array.isArray(routines) ? routines.map((routine) => normalizeRoutine(routine)) : [];
    }

    for (const routine of parsed) {
      await fetch("/api/routines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(serializeRoutine(normalizeRoutine(routine), true)),
      });
    }

    window.localStorage.removeItem(ROUTINES_STORAGE_KEY);
    return parsed.map((routine) => normalizeRoutine(routine));
  } catch {
    return Array.isArray(routines) ? routines.map((routine) => normalizeRoutine(routine)) : [];
  }
}

export async function saveRoutine(routine: Routine): Promise<Routine> {
  const normalizedRoutine = normalizeRoutine(routine);
  let res = await fetch("/api/routines", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(normalizedRoutine),
  });
  let data = await res.json().catch(() => null);
  if (!res.ok && data?.error === "invalid step type") {
    res = await fetch("/api/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(serializeRoutine(normalizedRoutine, true)),
    });
    data = await res.json().catch(() => null);
  }
  if (!res.ok) throw new Error(data?.error || "Failed to save routine");
  return data ? normalizeRoutine(data) : normalizedRoutine;
}

export async function deleteRoutine(id: string): Promise<void> {
  const res = await fetch(`/api/routines/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete routine");
}
