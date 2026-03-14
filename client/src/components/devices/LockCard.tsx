import { useCallback } from "react";
import {
  makeStyles,
  tokens,
  Card,
  Text,
  Button,
  Badge,
} from "@fluentui/react-components";
import {
  LockClosed24Regular,
  LockOpen24Regular,
} from "@fluentui/react-icons";
import type { UnifiedDevice, LockState } from "../../types/devices";
import { useAuth } from "../../contexts/AuthContext";
import { useDeviceContext } from "../../contexts/DeviceContext";
import { sendCommand } from "../../api/director";
import { sendDeviceCommand } from "../../services/device-commands";
import { isRemoteMode } from "../../config/transport";

const useStyles = makeStyles({
  card: { padding: "12px", minWidth: "200px" },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "8px",
  },
  iconLocked: { color: "#22c55e" },
  iconUnlocked: { color: "#ef4444" },
  name: {
    flex: 1,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  status: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: "8px",
  },
  battery: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginTop: "4px",
  },
});

export function LockCard({ device }: { device: UnifiedDevice }) {
  const styles = useStyles();
  const { state: auth } = useAuth();
  const { dispatch } = useDeviceContext();
  const ls = device.state as LockState;
  const c4Id = parseInt(device.id.replace("control4:", ""));

  const remote = isRemoteMode();

  const toggle = useCallback(async () => {
    const newLocked = !ls.locked;
    dispatch({ type: "UPDATE_DEVICE", payload: { id: device.id, state: { ...ls, locked: newLocked } } });
    try {
      if (remote) {
        await sendDeviceCommand("control4", c4Id, { on: !newLocked });
      } else {
        await sendCommand(
          { ip: auth.controllerIp || "", token: auth.directorToken || "" },
          c4Id,
          newLocked ? "LOCK" : "UNLOCK",
        );
      }
    } catch {
      dispatch({ type: "UPDATE_DEVICE", payload: { id: device.id, state: ls } });
    }
  }, [ls, device.id, c4Id, auth, dispatch, remote]);

  return (
    <Card className={styles.card}>
      <div className={styles.header}>
        {ls.locked ? (
          <LockClosed24Regular className={styles.iconLocked} />
        ) : (
          <LockOpen24Regular className={styles.iconUnlocked} />
        )}
        <Text className={styles.name} truncate wrap={false}>{device.name}</Text>
      </div>
      <div className={styles.status}>
        <Badge
          appearance="filled"
          color={ls.locked ? "success" : "danger"}
        >
          {ls.locked ? "Locked" : "Unlocked"}
        </Badge>
        <Button size="small" appearance="outline" onClick={toggle}>
          {ls.locked ? "Unlock" : "Lock"}
        </Button>
      </div>
      <div className={styles.battery}>Battery: {ls.batteryLevel}%</div>
    </Card>
  );
}
