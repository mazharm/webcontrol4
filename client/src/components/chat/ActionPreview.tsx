import { useCallback, useMemo, useState } from "react";
import { makeStyles, tokens, Card, Button, Text } from "@fluentui/react-components";
import type { LLMAction } from "../../types/api";
import type { Routine, RoutineStep, ThermostatState, LightState } from "../../types/devices";
import { useAuth } from "../../contexts/AuthContext";
import { useDeviceContext } from "../../contexts/DeviceContext";
import { sendCommand } from "../../api/director";
import { useDevices } from "../../hooks/useDevices";
import { getRoutines, saveRoutine } from "../../api/routines";
import { isRemoteMode } from "../../config/transport";
import { sendDeviceCommand } from "../../services/device-commands";

const useStyles = makeStyles({
  card: {
    padding: "10px",
    marginBottom: "8px",
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
  },
  desc: {
    fontSize: tokens.fontSizeBase300,
    marginBottom: "8px",
  },
  actions: {
    display: "flex",
    gap: "8px",
  },
  error: {
    color: tokens.colorPaletteRedForeground2,
    display: "block",
    marginTop: "8px",
  },
});

interface ActionPreviewProps {
  actions: LLMAction[];
  onComplete: () => void;
}

export function ActionPreview({ actions, onComplete }: ActionPreviewProps) {
  const styles = useStyles();
  const { state: auth } = useAuth();
  const { dispatch } = useDeviceContext();
  const { devices } = useDevices();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyDeviceUpdate = useCallback((action: {
    type: string;
    deviceId?: number;
    level?: unknown;
    on?: unknown;
    mode?: unknown;
    value?: unknown;
  }) => {
    if (!action.deviceId) return;
    const id = `control4:${action.deviceId}`;
    const existing = devices.get(id);

    if (action.type === "light_level") {
      const level = Number(action.level ?? 0);
      dispatch({ type: "UPDATE_DEVICE", payload: { id, state: { level, on: level > 0 } } });
      return;
    }

    if (action.type === "light_power" || action.type === "light_toggle") {
      const current = existing?.state as LightState | undefined;
      const on = Boolean(action.on);
      const level = on ? (current?.level && current.level > 0 ? current.level : 100) : 0;
      dispatch({ type: "UPDATE_DEVICE", payload: { id, state: { level, on } } });
      return;
    }

    if (action.type === "hvac_mode") {
      dispatch({
        type: "UPDATE_DEVICE",
        payload: { id, state: { hvacMode: (action.mode as ThermostatState["hvacMode"]) || "Off" } },
      });
      return;
    }

    if (action.type === "heat_setpoint") {
      dispatch({ type: "UPDATE_DEVICE", payload: { id, state: { heatSetpointF: Number(action.value ?? 68) } } });
      return;
    }

    if (action.type === "cool_setpoint") {
      dispatch({ type: "UPDATE_DEVICE", payload: { id, state: { coolSetpointF: Number(action.value ?? 74) } } });
    }
  }, [devices, dispatch]);

  const executeRoutineStep = useCallback(async (
    action: {
      type: string;
      deviceId?: number;
      level?: unknown;
      on?: unknown;
      mode?: unknown;
      value?: unknown;
    },
    opts: { ip: string; token: string },
  ) => {
    if (!action.deviceId) {
      throw new Error("Action is missing a deviceId.");
    }

    if (action.type === "light_level") {
      await sendCommand(opts, action.deviceId, "SET_LEVEL", { LEVEL: action.level ?? 0 });
    } else if (action.type === "light_power" || action.type === "light_toggle") {
      await sendCommand(opts, action.deviceId, "SET_LEVEL", { LEVEL: action.on ? 100 : 0 });
    } else if (action.type === "hvac_mode") {
      await sendCommand(opts, action.deviceId, "SET_MODE_HVAC", { MODE: action.mode ?? "Off" });
    } else if (action.type === "heat_setpoint") {
      await sendCommand(opts, action.deviceId, "SET_SETPOINT_HEAT", { FAHRENHEIT: action.value ?? 68 });
    } else if (action.type === "cool_setpoint") {
      await sendCommand(opts, action.deviceId, "SET_SETPOINT_COOL", { FAHRENHEIT: action.value ?? 74 });
    }
    applyDeviceUpdate(action);
  }, [applyDeviceUpdate]);

  const describeSchedule = useCallback((schedule: LLMAction["schedule"]) => {
    if (!schedule?.enabled || !schedule.time || !Array.isArray(schedule.days)) return "";
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayLabel = schedule.days.map((day) => dayNames[day] || day).join(", ");
    return ` at ${schedule.time}${dayLabel ? ` on ${dayLabel}` : ""}`;
  }, []);

  const describeAction = useCallback((action: LLMAction) => {
    const device = action.deviceId ? devices.get(`control4:${action.deviceId}`) : undefined;
    const name = action.deviceName || device?.name || (action.deviceId ? `Device ${action.deviceId}` : "Device");

    switch (action.type) {
      case "light_level":
        return `${name}: Set level to ${String(action.level ?? 0)}%`;
      case "light_power":
      case "light_toggle":
        return `${name}: Turn ${action.on ? "on" : "off"}`;
      case "hvac_mode":
        return `${name}: Set HVAC to ${String(action.mode ?? "Off")}`;
      case "heat_setpoint":
        return `${name}: Heat setpoint -> ${String(action.value ?? 68)}F`;
      case "cool_setpoint":
        return `${name}: Cool setpoint -> ${String(action.value ?? 74)}F`;
      case "run_routine":
        return `Run routine "${action.routineId || "unknown"}"`;
      case "create_routine":
        return `Create routine "${action.name || "Untitled"}" (${Array.isArray(action.steps) ? action.steps.length : 0} steps)${describeSchedule(action.schedule)}`;
      default:
        return action.deviceName || name;
    }
  }, [describeSchedule, devices]);

  const actionLabels = useMemo(() => actions.map((action) => describeAction(action)), [actions, describeAction]);

  const toRoutineStep = useCallback((step: Record<string, unknown>): RoutineStep => {
    const deviceId = Number(step.deviceId);
    const device = Number.isFinite(deviceId) ? devices.get(`control4:${deviceId}`) : undefined;
    const routineStep: RoutineStep = {
      type: step.type as RoutineStep["type"],
      deviceId,
      deviceName: typeof step.deviceName === "string" ? step.deviceName : (device?.name || `Device ${deviceId}`),
    };

    if (routineStep.type === "light_level") routineStep.level = Number(step.level ?? 0);
    if (routineStep.type === "light_power" || routineStep.type === "light_toggle") {
      routineStep.type = "light_power";
      routineStep.on = Boolean(step.on);
    }
    if (routineStep.type === "hvac_mode") routineStep.mode = (step.mode as RoutineStep["mode"]) || "Auto";
    if (routineStep.type === "heat_setpoint" || routineStep.type === "cool_setpoint") {
      routineStep.value = Number(step.value ?? 0);
    }

    return routineStep;
  }, [devices]);

  const executeRemoteAction = useCallback(async (action: LLMAction) => {
    if (!action.deviceId) return;
    if (action.type === "light_level") {
      await sendDeviceCommand("control4", action.deviceId, { level: action.level ?? 0 });
    } else if (action.type === "light_power" || action.type === "light_toggle") {
      await sendDeviceCommand("control4", action.deviceId, { on: action.on });
    } else if (action.type === "hvac_mode") {
      await sendDeviceCommand("control4", action.deviceId, { hvacMode: action.mode ?? "Off" });
    } else if (action.type === "heat_setpoint") {
      await sendDeviceCommand("control4", action.deviceId, { heatSetpointF: action.value ?? 68 });
    } else if (action.type === "cool_setpoint") {
      await sendDeviceCommand("control4", action.deviceId, { coolSetpointF: action.value ?? 74 });
    }
    applyDeviceUpdate(action);
  }, [applyDeviceUpdate]);

  const execute = useCallback(async () => {
    const remote = isRemoteMode();

    if (!remote && (!auth.controllerIp || !auth.directorToken)) {
      setError("Controller connection details are missing.");
      return;
    }

    setRunning(true);
    setError(null);
    const opts = { ip: auth.controllerIp || "", token: auth.directorToken || "" };
    const failedActions: string[] = [];

    for (const action of actions) {
      try {
        if (["light_level", "light_power", "light_toggle", "hvac_mode", "heat_setpoint", "cool_setpoint"].includes(action.type)) {
          if (remote) {
            await executeRemoteAction(action);
          } else {
            await executeRoutineStep(action, opts);
          }
        } else if (action.type === "run_routine") {
          if (remote) {
            // In remote mode, publish routine execute command via MQTT
            const { executeRoutine } = await import("../../services/device-commands");
            executeRoutine(action.routineId || "");
          } else {
            const routines = await getRoutines();
            const routine = routines.find((candidate) => candidate.id === action.routineId);
            if (!routine) {
              throw new Error(`Routine ${action.routineId || "unknown"} not found.`);
            }
            for (const step of routine.steps) {
              await executeRoutineStep(step, opts);
            }
          }
        } else if (action.type === "create_routine") {
          if (remote) {
            // Routine creation not supported in remote mode
            throw new Error("Routine creation is not available remotely.");
          }
          if (!action.name || !Array.isArray(action.steps) || action.steps.length === 0) {
            throw new Error("Routine action is missing a name or steps.");
          }

          const routine: Routine = {
            id: (typeof crypto !== "undefined" && crypto.randomUUID)
              ? crypto.randomUUID()
              : `r_${Date.now()}`,
            name: action.name,
            steps: action.steps.map((step) => toRoutineStep(step)),
          };

          if (action.schedule?.enabled && action.schedule.time && Array.isArray(action.schedule.days)) {
            routine.schedule = {
              enabled: true,
              time: action.schedule.time,
              days: action.schedule.days.map((day) => Number(day)).filter((day) => Number.isFinite(day)),
            };
          }

          await saveRoutine(routine);
        }
      } catch (err) {
        console.error('[ActionPreview] Action failed:', err);
        failedActions.push(describeAction(action));
      }
    }

    setRunning(false);

    if (failedActions.length > 0) {
      setError(`Failed to execute: ${failedActions.join(", ")}`);
      return;
    }

    onComplete();
  }, [actions, auth.controllerIp, auth.directorToken, describeAction, executeRemoteAction, executeRoutineStep, onComplete, toRoutineStep]);

  return (
    <Card className={styles.card}>
      <Text className={styles.desc}>
        {actionLabels.join(", ")}
      </Text>
      <div className={styles.actions}>
        <Button size="small" appearance="primary" onClick={execute} disabled={running}>
          {running ? "Executing..." : "Approve"}
        </Button>
        <Button size="small" appearance="subtle" onClick={onComplete} disabled={running}>Dismiss</Button>
      </div>
      {error && <Text className={styles.error}>{error}</Text>}
    </Card>
  );
}
