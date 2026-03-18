import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { getGoveeLeakStatus } from "../api/settings";
import { isRemoteMode } from "../config/transport";
import type { GoveeSensor, GoveeLeakStatus } from "../types/api";

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

function ensureSSE() {
  if (es || isRemoteMode()) return;
  es = new EventSource("/api/events");

  // Full refresh when Govee connects/disconnects/discovers devices
  es.addEventListener("govee:status", () => {
    fetchStatus();
  });

  // Incremental update on individual leak events
  es.addEventListener("govee:leak", (e) => {
    try {
      const event = JSON.parse(e.data);
      const sensors = currentState.sensors.map((s) =>
        s.id === event.device
          ? {
              ...s,
              leakDetected: event.leakDetected,
              battery: event.battery ?? s.battery,
              online: event.online ?? s.online,
              gwOnline: event.gwOnline ?? s.gwOnline,
              lastTime: event.lastTime ?? s.lastTime,
            }
          : s
      );
      setState({
        ...currentState,
        sensors,
        anyLeak: sensors.some((s) => s.leakDetected),
      });
    } catch {
      // ignore
    }
  });

  es.onerror = () => {
    // Reconnect handled by browser EventSource auto-reconnect
  };
}

function subscribe(listener: Listener) {
  listeners.add(listener);

  // First subscriber: initialize
  if (!initialized) {
    initialized = true;
    fetchStatus();
    ensureSSE();
  }

  return () => {
    listeners.delete(listener);
    // Don't tear down SSE — keep it alive for the app lifetime
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
