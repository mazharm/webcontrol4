// ---------------------------------------------------------------------------
// Shared singleton EventSource for /api/events
// Both useSSE and useGoveeSensors use this to avoid duplicate connections.
// ---------------------------------------------------------------------------

let sharedES: EventSource | null = null;
let refCount = 0;

export function acquireEventSource(): EventSource {
  if (!sharedES || sharedES.readyState === EventSource.CLOSED) {
    sharedES = new EventSource("/api/events");
  }
  refCount++;
  return sharedES;
}

export function releaseEventSource(): void {
  refCount--;
  if (refCount <= 0) {
    refCount = 0;
    sharedES?.close();
    sharedES = null;
  }
}

/** Get the current shared EventSource without ref-counting (for module-level singletons). */
export function getSharedEventSource(): EventSource {
  if (!sharedES || sharedES.readyState === EventSource.CLOSED) {
    sharedES = new EventSource("/api/events");
  }
  return sharedES;
}
