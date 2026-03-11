import { useEffect, useRef } from "react";
import type { DeviceAction } from "../contexts/DeviceContext";

export function useSSE(dispatch: React.Dispatch<DeviceAction>) {
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/events");
    esRef.current = es;

    es.addEventListener("state", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.itemId && data.varName !== undefined) {
          dispatch({
            type: "UPDATE_DEVICE_VAR",
            payload: {
              itemId: data.itemId,
              varName: data.varName,
              value: data.value,
              deviceName: data.name,
              room: data.room,
              roomId: data.roomId,
              floor: data.floor,
              deviceType: data.deviceType,
            },
          });
        }
      } catch {
        // ignore parse errors
      }
    });

    es.addEventListener("alert", (e) => {
      try {
        const data = JSON.parse(e.data);
        dispatch({ type: "SET_ALERTS", payload: data.alerts || [] });
      } catch {
        // ignore
      }
    });

    es.addEventListener("homeState", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.alerts) {
          dispatch({ type: "SET_ALERTS", payload: data.alerts });
        }
      } catch {
        // ignore
      }
    });

    es.onerror = () => {
      dispatch({ type: "SET_CONNECTION", payload: "disconnected" });
    };

    es.onopen = () => {
      dispatch({ type: "SET_CONNECTION", payload: "connected" });
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [dispatch]);
}
