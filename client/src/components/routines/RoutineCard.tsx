import { useState, useCallback } from "react";
import {
  makeStyles,
  tokens,
  Card,
  Text,
  Button,
  Badge,
} from "@fluentui/react-components";
import {
  Play24Regular,
  Edit24Regular,
  Delete24Regular,
  Clock24Regular,
} from "@fluentui/react-icons";
import type { Routine } from "../../types/devices";
import { useAuth } from "../../contexts/AuthContext";
import { sendCommand } from "../../api/director";
import { deleteRoutine } from "../../api/routines";
import { executeRoutine as mqttExecuteRoutine } from "../../services/device-commands";

const useStyles = makeStyles({
  card: { padding: "12px" },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "8px",
  },
  name: {
    flex: 1,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase400,
  },
  steps: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginBottom: "8px",
  },
  schedule: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginBottom: "8px",
  },
  actions: {
    display: "flex",
    gap: "8px",
  },
});

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface RoutineCardProps {
  routine: Routine;
  onEdit: (routine: Routine) => void;
  onDeleted: () => void;
  remote?: boolean;
}

export function RoutineCard({ routine, onEdit, onDeleted, remote }: RoutineCardProps) {
  const styles = useStyles();
  const { state: auth } = useAuth();
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    if (remote) {
      mqttExecuteRoutine(routine.id);
      // Brief delay to show feedback since MQTT is fire-and-forget
      setTimeout(() => setRunning(false), 1500);
      return;
    }
    const opts = { ip: auth.controllerIp || "", token: auth.directorToken || "" };
    for (const step of routine.steps) {
      try {
        if (step.type === "light_level") {
          await sendCommand(opts, step.deviceId, "SET_LEVEL", { LEVEL: step.level ?? 0 });
        } else if (step.type === "light_power" || step.type === "light_toggle") {
          await sendCommand(opts, step.deviceId, "SET_LEVEL", { LEVEL: step.on ? 100 : 0 });
        } else if (step.type === "hvac_mode") {
          await sendCommand(opts, step.deviceId, "SET_MODE_HVAC", { MODE: step.mode ?? "Off" });
        } else if (step.type === "heat_setpoint") {
          await sendCommand(opts, step.deviceId, "SET_SETPOINT_HEAT", { FAHRENHEIT: step.value ?? 68 });
        } else if (step.type === "cool_setpoint") {
          await sendCommand(opts, step.deviceId, "SET_SETPOINT_COOL", { FAHRENHEIT: step.value ?? 74 });
        }
      } catch { /* continue */ }
    }
    setRunning(false);
  }, [routine, auth, remote]);

  const handleDelete = useCallback(async () => {
    try {
      await deleteRoutine(routine.id);
      onDeleted();
    } catch { /* ignore */ }
  }, [routine.id, onDeleted]);

  return (
    <Card className={styles.card}>
      <div className={styles.header}>
        <Text className={styles.name}>{routine.name}</Text>
        <Badge appearance="outline" size="small">{routine.steps.length} steps</Badge>
      </div>
        <div className={styles.steps}>
          {routine.steps.slice(0, 3).map((s, i) => (
          <div key={i}>{s.deviceName}: {s.type === "light_power" || s.type === "light_toggle" ? "light power" : s.type.replace("_", " ")}</div>
          ))}
        {routine.steps.length > 3 && <div>...and {routine.steps.length - 3} more</div>}
      </div>
      {routine.schedule?.enabled && (
        <div className={styles.schedule}>
          <Clock24Regular style={{ width: 16, height: 16 }} />
          {routine.schedule.time} on {routine.schedule.days.map((d) => dayNames[d]).join(", ")}
        </div>
      )}
      <div className={styles.actions}>
        <Button size="small" appearance="primary" icon={<Play24Regular />} onClick={run} disabled={running}>
          {running ? "Running..." : "Run"}
        </Button>
        {!remote && (
          <Button size="small" appearance="subtle" icon={<Edit24Regular />} onClick={() => onEdit(routine)}>
            Edit
          </Button>
        )}
        {!remote && (
          <Button size="small" appearance="subtle" icon={<Delete24Regular />} onClick={handleDelete}>
            Delete
          </Button>
        )}
      </div>
    </Card>
  );
}
