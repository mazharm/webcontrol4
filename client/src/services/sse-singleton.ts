// ---------------------------------------------------------------------------
// Shared singleton EventSource for /api/events
// Both useSSE and useGoveeSensors use this to avoid duplicate connections.
// ---------------------------------------------------------------------------

let sharedES: EventSource | null = null;
let refCount = 0;
const EVENTS_URL = "/api/events";

export function acquireEventSource(): EventSource {
  if (!sharedES || sharedES.readyState === EventSource.CLOSED) {
    sharedES = new EventSource(EVENTS_URL);
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
