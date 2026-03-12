import { useState, useEffect, useCallback, useRef } from "react";
import { getGoveeLeakStatus } from "../api/settings";
import type { GoveeSensor } from "../types/api";

export function useGoveeSensors() {
  const [sensors, setSensors] = useState<GoveeSensor[]>([]);
  const [anyLeak, setAnyLeak] = useState(false);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const status = await getGoveeLeakStatus();
      if (!mountedRef.current) return;
      setSensors(status.sensors);
      setAnyLeak(status.anyLeak);
    } catch {
      // ignore
    }
    if (mountedRef.current) setLoading(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();

    // Listen for SSE govee:leak events
    const es = new EventSource("/api/events");
    es.addEventListener("govee:leak", (e) => {
      try {
        const event = JSON.parse(e.data);
        if (!mountedRef.current) return;
        setSensors((prev) => {
          const updated = prev.map((s) =>
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
          setAnyLeak(updated.some((s) => s.leakDetected));
          return updated;
        });
      } catch {
        // ignore
      }
    });

    return () => {
      mountedRef.current = false;
      es.close();
    };
  }, [refresh]);

  return { sensors, anyLeak, loading, refresh };
}
