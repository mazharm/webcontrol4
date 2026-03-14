// ---------------------------------------------------------------------------
// services/rpc-cache.ts – In-memory stale-while-revalidate cache for RPC data
// ---------------------------------------------------------------------------

const cache = new Map<string, { data: unknown; ts: number }>();

export function getCached<T>(key: string): T | undefined {
  const entry = cache.get(key);
  return entry ? (entry.data as T) : undefined;
}

export function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, ts: Date.now() });
}
