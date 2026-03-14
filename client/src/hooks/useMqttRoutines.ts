// ---------------------------------------------------------------------------
// hooks/useMqttRoutines.ts – Routine list + trigger hook (mqtt mode only)
// ---------------------------------------------------------------------------

import { useState, useEffect, useCallback } from "react";
import { subscribe } from "../services/mqtt-client";
import { executeRoutine as execRoutine } from "../services/device-commands";
import { getMqttConfig } from "../config/transport";

export interface MqttRoutine {
  id: string;
  name: string;
  steps: number;
  hasSchedule: boolean;
  hasConditions: boolean;
}

export interface RoutineResult {
  success: boolean;
  routineName?: string;
  stepsExecuted?: number;
  error?: string;
  ts: string;
}

export function useMqttRoutines() {
  const [routines, setRoutines] = useState<MqttRoutine[]>([]);
  const [lastResult, setLastResult] = useState<RoutineResult | null>(null);

  useEffect(() => {
    const config = getMqttConfig();

    // Subscribe to routine list
    const unsubList = subscribe(
      `wc4/${config.homeId}/state/routines/list`,
      (payload: unknown) => {
        if (Array.isArray(payload)) {
          setRoutines(payload as MqttRoutine[]);
        }
      },
    );

    // Subscribe to routine results (wildcard)
    const unsubResult = subscribe(
      `wc4/${config.homeId}/state/routines/+/result`,
      (payload: unknown) => {
        setLastResult(payload as RoutineResult);
      },
    );

    return () => {
      unsubList();
      unsubResult();
    };
  }, []);

  const executeRoutine = useCallback((routineId: string) => {
    execRoutine(routineId);
  }, []);

  return { routines, executeRoutine, lastResult };
}
