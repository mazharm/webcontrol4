import { useCallback } from "react";
import {
  makeStyles,
  tokens,
  Card,
  Text,
  Button,
  Dropdown,
  Option,
} from "@fluentui/react-components";
import { Temperature24Regular } from "@fluentui/react-icons";
import type { UnifiedDevice, ThermostatState } from "../../types/devices";
import { useAuth } from "../../contexts/AuthContext";
import { useDeviceContext } from "../../contexts/DeviceContext";
import { sendCommand } from "../../api/director";
import { sendDeviceCommand } from "../../services/device-commands";
import { isRemoteMode } from "../../config/transport";

const useStyles = makeStyles({
  card: { padding: "12px", minWidth: "220px" },
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
  currentTemp: {
    fontSize: tokens.fontSizeHero700,
    fontWeight: tokens.fontWeightBold,
    color: tokens.colorBrandForeground1,
    textAlign: "center",
    marginBottom: "8px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "6px",
  },
  label: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  setpoint: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
  setpointValue: {
    minWidth: "32px",
    textAlign: "center",
    fontWeight: tokens.fontWeightSemibold,
  },
  modeRow: {
    marginTop: "8px",
  },
  info: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginTop: "4px",
  },
});

interface ThermostatCardProps {
  device: UnifiedDevice;
}

export function ThermostatCard({ device }: ThermostatCardProps) {
  const styles = useStyles();
  const { state: auth } = useAuth();
  const { dispatch } = useDeviceContext();
  const ts = device.state as ThermostatState;
  const c4Id = parseInt(device.id.replace("control4:", ""));

  const directorOpts = {
    ip: auth.controllerIp || "",
    token: auth.directorToken || "",
  };

  const remote = isRemoteMode();

  const adjustSetpoint = useCallback(async (field: "heatSetpointF" | "coolSetpointF", delta: number) => {
    const newVal = ts[field] + delta;
    if (newVal < 32 || newVal > 120) return;
    const newState = { ...ts, [field]: newVal };
    dispatch({ type: "UPDATE_DEVICE", payload: { id: device.id, state: newState } });
    try {
      if (remote) {
        await sendDeviceCommand("control4", c4Id, { [field]: newVal });
      } else {
        const command = field === "heatSetpointF" ? "SET_SETPOINT_HEAT" : "SET_SETPOINT_COOL";
        await sendCommand(directorOpts, c4Id, command, { FAHRENHEIT: newVal });
      }
    } catch {
      dispatch({ type: "UPDATE_DEVICE", payload: { id: device.id, state: ts } });
    }
  }, [ts, device.id, c4Id, directorOpts, dispatch, remote]);

  const changeMode = useCallback(async (mode: string) => {
    const newState = { ...ts, hvacMode: mode as ThermostatState["hvacMode"] };
    dispatch({ type: "UPDATE_DEVICE", payload: { id: device.id, state: newState } });
    try {
      if (remote) {
        await sendDeviceCommand("control4", c4Id, { hvacMode: mode });
      } else {
        await sendCommand(directorOpts, c4Id, "SET_MODE_HVAC", { MODE: mode });
      }
    } catch {
      dispatch({ type: "UPDATE_DEVICE", payload: { id: device.id, state: ts } });
    }
  }, [ts, device.id, c4Id, directorOpts, dispatch, remote]);

  return (
    <Card className={styles.card}>
      <div className={styles.header}>
        <Temperature24Regular />
        <Text className={styles.name} truncate wrap={false}>{device.name}</Text>
      </div>
      <div className={styles.currentTemp}>{Math.round(ts.currentTempF)}°F</div>
      <div className={styles.row}>
        <span className={styles.label}>Heat</span>
        <div className={styles.setpoint}>
          <Button size="medium" appearance="subtle" onClick={() => adjustSetpoint("heatSetpointF", -1)}>-</Button>
          <span className={styles.setpointValue}>{Math.round(ts.heatSetpointF)}</span>
          <Button size="medium" appearance="subtle" onClick={() => adjustSetpoint("heatSetpointF", 1)}>+</Button>
        </div>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Cool</span>
        <div className={styles.setpoint}>
          <Button size="medium" appearance="subtle" onClick={() => adjustSetpoint("coolSetpointF", -1)}>-</Button>
          <span className={styles.setpointValue}>{Math.round(ts.coolSetpointF)}</span>
          <Button size="medium" appearance="subtle" onClick={() => adjustSetpoint("coolSetpointF", 1)}>+</Button>
        </div>
      </div>
      <div className={styles.modeRow}>
        <Dropdown
          value={ts.hvacMode}
          selectedOptions={[ts.hvacMode]}
          onOptionSelect={(_, data) => data.optionValue && changeMode(data.optionValue)}
          style={{ width: "100%" }}
        >
          <Option value="Off">Off</Option>
          <Option value="Heat">Heat</Option>
          <Option value="Cool">Cool</Option>
          <Option value="Auto">Auto</Option>
        </Dropdown>
      </div>
      <div className={styles.info}>
        {ts.hvacState} {ts.humidity > 0 && `| ${Math.round(ts.humidity)}% humid`}
      </div>
    </Card>
  );
}
