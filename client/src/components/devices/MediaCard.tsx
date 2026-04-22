import { useCallback, useRef, useEffect, useMemo } from "react";
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

  const directorOpts = useMemo(() => ({ ip: auth.controllerIp || "", token: auth.directorToken || "" }), [auth.controllerIp, auth.directorToken]);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const remote = isRemoteMode();

  const togglePower = useCallback(async () => {
    const newState = { ...ms, powerOn: !ms.powerOn };
    dispatch({ type: "UPDATE_DEVICE", payload: { id: device.id, state: newState } });
    try {
      if (remote) {
        await sendDeviceCommand("control4", c4Id, { on: !ms.powerOn });
      } else {
        await sendCommand(directorOpts, c4Id, ms.powerOn ? "OFF" : "ON");
      }
    } catch {
      dispatch({ type: "UPDATE_DEVICE", payload: { id: device.id, state: ms } });
    }
  }, [ms, device.id, c4Id, directorOpts, dispatch, remote]);

  const onVolumeChange = useCallback((_: unknown, data: { value: number }) => {
    const newVolume = data.value;
    const newState = { ...ms, volume: newVolume };
    dispatch({ type: "UPDATE_DEVICE", payload: { id: device.id, state: newState } });
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        if (remote) {
          await sendDeviceCommand("control4", c4Id, { volume: newVolume });
        } else {
          await sendCommand(directorOpts, c4Id, "SET_VOLUME_LEVEL", { LEVEL: newVolume });
        }
      } catch {
        dispatch({ type: "UPDATE_DEVICE", payload: { id: device.id, state: ms } });
      }
    }, 300);
  }, [ms, device.id, c4Id, directorOpts, dispatch, remote]);

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
        <Slider min={0} max={100} value={ms.volume} disabled={!ms.powerOn} style={{ flex: 1 }} onChange={onVolumeChange} />
        <Text>{ms.volume}%</Text>
      </div>
    </Card>
  );
}
