// ---------------------------------------------------------------------------
// hooks/useBridgeStatus.ts – Bridge health hook (mqtt mode only)
// ---------------------------------------------------------------------------

import { useState, useEffect } from "react";
import { subscribe } from "../services/mqtt-client";
import { getMqttConfig } from "../config/transport";

interface BridgeStatus {
  online: boolean;
  uptime: number;
  lastSeen: Date | null;
}

export function useBridgeStatus(): BridgeStatus {
  const [status, setStatus] = useState<BridgeStatus>({
    online: false,
    uptime: 0,
    lastSeen: null,
  });

  useEffect(() => {
    const config = getMqttConfig();
    const topic = `wc4/${config.homeId}/status/bridge`;

    const unsubscribe = subscribe(topic, (payload: unknown) => {
      const data = payload as { online?: boolean; uptime?: number; ts?: string };
      setStatus({
        online: data.online ?? false,
        uptime: data.uptime ?? 0,
        lastSeen: data.ts ? new Date(data.ts) : new Date(),
      });
    });

    return unsubscribe;
  }, []);

  return status;
}
