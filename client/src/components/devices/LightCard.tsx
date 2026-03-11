import { useCallback, useRef } from "react";
import {
  makeStyles,
  tokens,
  Card,
  CardHeader,
  Switch,
  Slider,
  Text,
} from "@fluentui/react-components";
import { Lightbulb24Regular, Lightbulb24Filled } from "@fluentui/react-icons";
import type { UnifiedDevice, LightState } from "../../types/devices";
import { useAuth } from "../../contexts/AuthContext";
import { useDeviceContext } from "../../contexts/DeviceContext";
import { sendCommand } from "../../api/director";

const useStyles = makeStyles({
  card: {
    padding: "12px",
    minWidth: "200px",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "8px",
  },
  iconOn: { color: "#eab308" },
  iconOff: { color: tokens.colorNeutralForeground3 },
  name: {
    flex: 1,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  level: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginTop: "4px",
    textAlign: "right",
  },
});

interface LightCardProps {
  device: UnifiedDevice;
}

export function LightCard({ device }: LightCardProps) {
  const styles = useStyles();
  const { state: auth } = useAuth();
  const { dispatch } = useDeviceContext();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const lightState = device.state as LightState;
  const c4Id = device.id.replace("control4:", "");

  const directorOpts = {
    ip: auth.controllerIp || "",
    token: auth.directorToken || "",
  };

  const toggle = useCallback(async () => {
    const newOn = !lightState.on;
    const newLevel = newOn ? (lightState.level > 0 ? lightState.level : 100) : 0;
    dispatch({
      type: "UPDATE_DEVICE",
      payload: { id: device.id, state: { type: "light", on: newOn, level: newLevel } },
    });
    try {
      await sendCommand(directorOpts, parseInt(c4Id), newOn ? "SET_LEVEL" : "SET_LEVEL", { LEVEL: newLevel });
    } catch {
      // revert on error
      dispatch({
        type: "UPDATE_DEVICE",
        payload: { id: device.id, state: lightState },
      });
    }
  }, [lightState, device.id, c4Id, directorOpts, dispatch]);

  const onSlider = useCallback((value: number) => {
    dispatch({
      type: "UPDATE_DEVICE",
      payload: { id: device.id, state: { type: "light", on: value > 0, level: value } },
    });
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        await sendCommand(directorOpts, parseInt(c4Id), "SET_LEVEL", { LEVEL: value });
      } catch {
        // ignore
      }
    }, 300);
  }, [device.id, c4Id, directorOpts, dispatch]);

  return (
    <Card className={styles.card}>
      <div className={styles.header}>
        {lightState.on ? (
          <Lightbulb24Filled className={styles.iconOn} />
        ) : (
          <Lightbulb24Regular className={styles.iconOff} />
        )}
        <Text className={styles.name} truncate wrap={false}>{device.name}</Text>
        <Switch checked={lightState.on} onChange={toggle} aria-label={`Toggle ${device.name}`} />
      </div>
      <Slider
        min={0}
        max={100}
        value={lightState.level}
        onChange={(_, data) => onSlider(data.value)}
        aria-label={`${device.name} brightness`}
      />
      <div className={styles.level}>{lightState.level}%</div>
    </Card>
  );
}
