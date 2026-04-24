import { useSyncExternalStore } from "react";
import { getGoveeLeakStatus } from "../api/settings";
import { isRemoteMode } from "../config/transport";
import { acquireEventSource, releaseEventSource } from "../services/sse-singleton";
import type { GoveeLeakStatus } from "../types/api";

// ---------------------------------------------------------------------------
// Shared singleton store — one fetch, one SSE listener, many subscribers.
// Avoids duplicate EventSource connections per component.
// ---------------------------------------------------------------------------

type Listener = () => void;

const listeners = new Set<Listener>();
let currentState: GoveeLeakStatus = { sensorCount: 0, anyLeak: false, needsReauth: false, sensors: [] };
let initialized = false;
let fetchInFlight = false;
let es: EventSource | null = null;

function notify() {
  for (const fn of listeners) fn();
}

function setState(next: GoveeLeakStatus) {
  currentState = next;
  notify();
}

async function fetchStatus() {
  if (fetchInFlight || isRemoteMode()) return;
  fetchInFlight = true;
  try {
    const status = await getGoveeLeakStatus();
    setState(status);
  } catch {
    // ignore — keep previous state
  }
  fetchInFlight = false;
}

function handleGoveeStatus() {
  void fetchStatus();
}

function handleGoveeLeak(event: Event) {
  try {
    const payload = JSON.parse((event as MessageEvent).data) as {
      device?: string;
      leakDetected?: boolean;
      battery?: number;
      online?: boolean;
      gwOnline?: boolean;
      lastTime?: number;
    };
    const sensors = currentState.sensors.map((s) =>
      s.id === payload.device
        ? {
            ...s,
            leakDetected: payload.leakDetected ?? s.leakDetected,
            battery: payload.battery ?? s.battery,
            online: payload.online ?? s.online,
            gwOnline: payload.gwOnline ?? s.gwOnline,
            lastTime: payload.lastTime ?? s.lastTime,
          }
        : s
    );
    setState({
      ...currentState,
      sensors,
      anyLeak: sensors.some((s) => s.leakDetected),
    });
  } catch {
    // ignore malformed SSE
  }
}

function ensureSSE() {
  if (es || isRemoteMode()) return;
  es = acquireEventSource();

  // Full refresh when Govee connects/disconnects/discovers devices
  es.addEventListener("govee:status", handleGoveeStatus);

  // Incremental update on individual leak events
  es.addEventListener("govee:leak", handleGoveeLeak);
}

function teardownSSE() {
  if (!es) return;
  es.removeEventListener("govee:status", handleGoveeStatus);
  es.removeEventListener("govee:leak", handleGoveeLeak);
  releaseEventSource();
  es = null;
}

function subscribe(listener: Listener) {
  listeners.add(listener);

  if (listeners.size === 1) {
    initialized = true;
    ensureSSE();
    void fetchStatus();
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      teardownSSE();
    }
  };
}

function getSnapshot(): GoveeLeakStatus {
  return currentState;
}

// Public: force a re-fetch (e.g. after login)
export function refreshGoveeSensors() {
  fetchStatus();
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export function useGoveeSensors() {
  const state = useSyncExternalStore(subscribe, getSnapshot);

  return {
    sensors: state.sensors,
    anyLeak: state.anyLeak,
    loading: !initialized || (state.sensors.length === 0 && fetchInFlight),
    refresh: refreshGoveeSensors,
  };
}
