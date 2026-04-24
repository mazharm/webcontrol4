import { useEffect } from "react";
import { acquireEventSource, releaseEventSource } from "../services/sse-singleton";
import type { DeviceAction } from "../contexts/DeviceContext";
import type { Alert } from "../types/devices";

export function useSSE(dispatch: React.Dispatch<DeviceAction>) {
  useEffect(() => {
    const es = acquireEventSource();

    const handleState = (e: Event) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse((e as MessageEvent).data);
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
    };

    const handleAlert = (e: Event) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse((e as MessageEvent).data);
      } catch {
        return;
      }
      dispatch({ type: "SET_ALERTS", payload: (data.alerts as Alert[]) || [] });
    };

    const handleHomeState = (e: Event) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse((e as MessageEvent).data);
      } catch {
        return;
      }
      if (data.alerts) {
        dispatch({ type: "SET_ALERTS", payload: data.alerts as Alert[] });
      }
    };

    const handleError = () => {
      dispatch({ type: "SET_CONNECTION", payload: "disconnected" });
    };

    const handleOpen = () => {
      dispatch({ type: "SET_CONNECTION", payload: "connected" });
    };

    es.addEventListener("state", handleState);
    es.addEventListener("alert", handleAlert);
    es.addEventListener("homeState", handleHomeState);
    es.addEventListener("error", handleError);
    es.addEventListener("open", handleOpen);

    return () => {
      es.removeEventListener("state", handleState);
      es.removeEventListener("alert", handleAlert);
      es.removeEventListener("homeState", handleHomeState);
      es.removeEventListener("error", handleError);
      es.removeEventListener("open", handleOpen);
      releaseEventSource();
    };
  }, [dispatch]);
}
