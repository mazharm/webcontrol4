// ---------------------------------------------------------------------------
// services/rpc-cache.ts – In-memory stale-while-revalidate cache for RPC data
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 60_000; // 60 seconds

const cache = new Map<string, { data: unknown; ts: number }>();

export function getCached<T>(key: string, ttlMs: number = DEFAULT_TTL_MS): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > ttlMs) {
    cache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

export function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, ts: Date.now() });
}
