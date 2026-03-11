import { useCallback } from "react";
import { makeStyles, tokens, Card, Button, Text } from "@fluentui/react-components";
import type { LLMAction } from "../../types/api";
import { useAuth } from "../../contexts/AuthContext";
import { sendCommand } from "../../api/director";

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
});

interface ActionPreviewProps {
  actions: LLMAction[];
  onComplete: () => void;
}

export function ActionPreview({ actions, onComplete }: ActionPreviewProps) {
  const styles = useStyles();
  const { state: auth } = useAuth();

  const execute = useCallback(async () => {
    const opts = { ip: auth.controllerIp || "", token: auth.directorToken || "" };
    for (const action of actions) {
      try {
        if (action.type === "light_level") {
          await sendCommand(opts, action.deviceId, "SET_LEVEL", { LEVEL: action.level ?? 0 });
        } else if (action.type === "light_toggle") {
          const level = action.on ? 100 : 0;
          await sendCommand(opts, action.deviceId, "SET_LEVEL", { LEVEL: level });
        } else if (action.type === "hvac_mode") {
          await sendCommand(opts, action.deviceId, "SET_MODE_HVAC", { MODE: action.mode ?? "Off" });
        } else if (action.type === "heat_setpoint") {
          await sendCommand(opts, action.deviceId, "SET_SETPOINT_HEAT", { FAHRENHEIT: action.value ?? 68 });
        } else if (action.type === "cool_setpoint") {
          await sendCommand(opts, action.deviceId, "SET_SETPOINT_COOL", { FAHRENHEIT: action.value ?? 74 });
        }
      } catch {
        // continue with remaining actions
      }
    }
    onComplete();
  }, [actions, auth, onComplete]);

  return (
    <Card className={styles.card}>
      <Text className={styles.desc}>
        {actions.map((a) => `${a.type}: ${a.deviceName}`).join(", ")}
      </Text>
      <div className={styles.actions}>
        <Button size="small" appearance="primary" onClick={execute}>Approve</Button>
        <Button size="small" appearance="subtle" onClick={onComplete}>Dismiss</Button>
      </div>
    </Card>
  );
}
