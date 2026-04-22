/**
 * Safely parse a JSON response, guarding against non-JSON responses (e.g., HTML error pages).
 * Checks res.ok and content-type before calling res.json().
 */
export async function safeJson<T = unknown>(res: Response, errorPrefix = "API error"): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      try {
        const body = await res.json();
        detail = body?.error || body?.message || JSON.stringify(body);
      } catch { /* use statusText */ }
    }
    throw new Error(`${errorPrefix}: ${detail}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`${errorPrefix}: expected JSON response but received ${contentType || "unknown content-type"}`);
  }

  return res.json() as Promise<T>;
}
