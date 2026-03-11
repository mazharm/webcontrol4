import { useCallback } from "react";
import {
  makeStyles,
  tokens,
  Card,
  Text,
  Badge,
  Button,
} from "@fluentui/react-components";
import { ShieldLock24Regular } from "@fluentui/react-icons";
import type { UnifiedDevice, SecurityState } from "../../types/devices";
import { setAlarmMode } from "../../api/ring";

const useStyles = makeStyles({
  card: { padding: "12px", minWidth: "200px" },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "12px",
  },
  name: {
    flex: 1,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  modeRow: {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
    marginTop: "8px",
  },
  info: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginTop: "8px",
  },
});

export function SecurityCard({ device }: { device: UnifiedDevice }) {
  const styles = useStyles();
  const ss = device.state as SecurityState;

  const modeColor = ss.mode === "away" ? "danger" : ss.mode === "home" ? "warning" : "success";

  const onSetMode = useCallback(async (mode: string) => {
    try {
      await setAlarmMode(mode);
    } catch { /* ignore */ }
  }, []);

  return (
    <Card className={styles.card}>
      <div className={styles.header}>
        <ShieldLock24Regular />
        <Text className={styles.name} truncate wrap={false}>{device.name}</Text>
        <Badge appearance="filled" color={modeColor}>
          {ss.mode.charAt(0).toUpperCase() + ss.mode.slice(1)}
        </Badge>
      </div>
      <div className={styles.modeRow}>
        <Button size="small" appearance={ss.mode === "disarmed" ? "primary" : "outline"} onClick={() => onSetMode("disarmed")}>
          Disarm
        </Button>
        <Button size="small" appearance={ss.mode === "home" ? "primary" : "outline"} onClick={() => onSetMode("home")}>
          Home
        </Button>
        <Button size="small" appearance={ss.mode === "away" ? "primary" : "outline"} onClick={() => onSetMode("away")}>
          Away
        </Button>
      </div>
      {ss.partitionState && <div className={styles.info}>{ss.partitionState}</div>}
    </Card>
  );
}
