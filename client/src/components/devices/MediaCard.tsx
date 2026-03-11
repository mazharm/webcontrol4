import { useCallback } from "react";
import {
  makeStyles,
  tokens,
  Card,
  Text,
  Button,
  Slider,
} from "@fluentui/react-components";
import {
  Speaker224Regular,
  Power24Regular,
} from "@fluentui/react-icons";
import type { UnifiedDevice, MediaState } from "../../types/devices";
import { useAuth } from "../../contexts/AuthContext";
import { useDeviceContext } from "../../contexts/DeviceContext";
import { sendCommand } from "../../api/director";

const useStyles = makeStyles({
  card: { padding: "12px", minWidth: "200px" },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "8px",
  },
  name: {
    flex: 1,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  media: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginBottom: "8px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  volumeRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
});

export function MediaCard({ device }: { device: UnifiedDevice }) {
  const styles = useStyles();
  const { state: auth } = useAuth();
  const { dispatch } = useDeviceContext();
  const ms = device.state as MediaState;
  const c4Id = parseInt(device.id.replace("control4:", ""));

  const directorOpts = { ip: auth.controllerIp || "", token: auth.directorToken || "" };

  const togglePower = useCallback(async () => {
    const newState = { ...ms, powerOn: !ms.powerOn };
    dispatch({ type: "UPDATE_DEVICE", payload: { id: device.id, state: newState } });
    try {
      await sendCommand(directorOpts, c4Id, ms.powerOn ? "OFF" : "ON");
    } catch {
      dispatch({ type: "UPDATE_DEVICE", payload: { id: device.id, state: ms } });
    }
  }, [ms, device.id, c4Id, directorOpts, dispatch]);

  return (
    <Card className={styles.card}>
      <div className={styles.header}>
        <Speaker224Regular />
        <Text className={styles.name} truncate wrap={false}>{device.name}</Text>
        <Button
          size="small"
          icon={<Power24Regular />}
          appearance={ms.powerOn ? "primary" : "outline"}
          onClick={togglePower}
          aria-label="Power"
        />
      </div>
      {ms.currentMedia && <div className={styles.media}>{ms.currentMedia}</div>}
      <div className={styles.volumeRow}>
        <Speaker224Regular />
        <Slider min={0} max={100} value={ms.volume} disabled={!ms.powerOn} style={{ flex: 1 }} />
        <Text>{ms.volume}%</Text>
      </div>
    </Card>
  );
}
