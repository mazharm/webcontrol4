import { useEffect, useRef } from "react";
import { acquireEventSource, releaseEventSource } from "../services/sse-singleton";
import type { DeviceAction } from "../contexts/DeviceContext";
import type { Alert } from "../types/devices";

export function useSSE(dispatch: React.Dispatch<DeviceAction>) {
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = acquireEventSource();
    esRef.current = es;

    es.addEventListener("state", (e) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(e.data);
      } catch {
        return; // ignore malformed SSE
      }
      if (data.itemId && data.varName !== undefined) {
        dispatch({
          type: "UPDATE_DEVICE_VAR",
          payload: {
            itemId: data.itemId as number,
            varName: data.varName as string,
            value: data.value as string,
            deviceName: data.name as string | undefined,
            room: data.room as string | undefined,
            roomId: data.roomId as number | undefined,
            floor: data.floor as string | undefined,
            deviceType: data.deviceType as string | undefined,
          },
        });
      }
    });

    es.addEventListener("alert", (e) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      dispatch({ type: "SET_ALERTS", payload: (data.alerts as Alert[]) || [] });
    });

    es.addEventListener("homeState", (e) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      if (data.alerts) {
        dispatch({ type: "SET_ALERTS", payload: data.alerts as Alert[] });
      }
    });

    es.onerror = () => {
      dispatch({ type: "SET_CONNECTION", payload: "disconnected" });
    };

    es.onopen = () => {
      dispatch({ type: "SET_CONNECTION", payload: "connected" });
    };

    return () => {
      releaseEventSource();
      esRef.current = null;
    };
  }, [dispatch]);
}
