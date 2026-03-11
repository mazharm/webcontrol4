import { useCallback } from "react";
import { useAuth } from "../contexts/AuthContext";

interface FetchOptions extends RequestInit {
  skipDirectorHeaders?: boolean;
}

export function useApi() {
  const { state: auth } = useAuth();

  const apiFetch = useCallback(async <T = unknown>(url: string, options: FetchOptions = {}): Promise<T> => {
    const { skipDirectorHeaders, ...fetchOpts } = options;
    const headers = new Headers(fetchOpts.headers);

    if (!skipDirectorHeaders && auth.controllerIp && auth.directorToken) {
      headers.set("X-Director-IP", auth.controllerIp);
      headers.set("X-Director-Token", auth.directorToken);
    }

    if (fetchOpts.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(url, { ...fetchOpts, headers });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`API ${response.status}: ${text || response.statusText}`);
    }
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      return response.json();
    }
    return response.text() as unknown as T;
  }, [auth.controllerIp, auth.directorToken]);

  return { apiFetch };
}
