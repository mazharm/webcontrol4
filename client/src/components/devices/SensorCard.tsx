import {
  makeStyles,
  tokens,
  Card,
  Text,
  Badge,
} from "@fluentui/react-components";
import {
  AlertOn24Regular,
  PresenceAvailable24Regular,
} from "@fluentui/react-icons";
import type { UnifiedDevice, SensorState } from "../../types/devices";
import { formatTimeAgo } from "../../utils/formatters";

const useStyles = makeStyles({
  card: { padding: "12px", minWidth: "200px" },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "8px",
  },
  triggered: { color: "#ef4444" },
  clear: { color: "#22c55e" },
  name: {
    flex: 1,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  info: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginTop: "4px",
  },
});

export function SensorCard({ device }: { device: UnifiedDevice }) {
  const styles = useStyles();
  const ss = device.state as SensorState;

  const kindLabel = ss.sensorKind === "motion" ? "Motion" : ss.sensorKind === "contact" ? "Contact" : ss.sensorKind;
  const statusLabel = ss.sensorKind === "motion"
    ? ss.triggered ? "Motion Detected" : "Clear"
    : ss.triggered ? "Open" : "Closed";

  return (
    <Card className={styles.card}>
      <div className={styles.header}>
        {ss.triggered ? (
          <AlertOn24Regular className={styles.triggered} />
        ) : (
          <PresenceAvailable24Regular className={styles.clear} />
        )}
        <Text className={styles.name} truncate wrap={false}>{device.name}</Text>
      </div>
      <Badge appearance="filled" color={ss.triggered ? "danger" : "success"}>
        {statusLabel}
      </Badge>
      <div className={styles.info}>
        {kindLabel} sensor
        {ss.lastTriggered && ` | Last: ${formatTimeAgo(ss.lastTriggered)}`}
        {ss.batteryLevel != null && ` | Battery: ${ss.batteryLevel}%`}
      </div>
    </Card>
  );
}
