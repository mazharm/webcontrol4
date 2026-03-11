import { useNavigate } from "react-router-dom";
import { makeStyles, tokens, Card, Text } from "@fluentui/react-components";
import type { UnifiedDevice, LightState, ThermostatState, LockState, SensorState, CameraState } from "../../types/devices";

const useStyles = makeStyles({
  card: {
    padding: "12px",
    cursor: "pointer",
    minWidth: "180px",
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground3,
    },
  },
  name: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase400,
    marginBottom: "8px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginBottom: "2px",
  },
});

interface RoomSummaryCardProps {
  roomId: number;
  roomName: string;
  devices: UnifiedDevice[];
}

export function RoomSummaryCard({ roomId, roomName, devices }: RoomSummaryCardProps) {
  const styles = useStyles();
  const navigate = useNavigate();

  const lights = devices.filter((d) => d.type === "light");
  const lightsOn = lights.filter((d) => (d.state as LightState).on).length;
  const thermostat = devices.find((d) => d.type === "thermostat");
  const lock = devices.find((d) => d.type === "lock");
  const cameras = devices.filter((d) => d.type === "camera");
  const motionSensor = devices.find((d) => d.type === "sensor" && (d.state as SensorState).sensorKind === "motion");

  return (
    <Card className={styles.card} onClick={() => navigate(`/room/${roomId}`)}>
      <Text className={styles.name}>{roomName}</Text>
      {thermostat && (
        <div className={styles.row}>
          {Math.round((thermostat.state as ThermostatState).currentTempF)}°F
          {" | "}
          {(thermostat.state as ThermostatState).hvacMode}
        </div>
      )}
      {lights.length > 0 && (
        <div className={styles.row}>
          {lightsOn}/{lights.length} lights on
        </div>
      )}
      {lock && (
        <div className={styles.row}>
          {(lock.state as LockState).locked ? "Locked" : "Unlocked"}
        </div>
      )}
      {motionSensor && (
        <div className={styles.row}>
          Motion: {(motionSensor.state as SensorState).triggered ? "Active" : "Clear"}
        </div>
      )}
      {cameras.length > 0 && (
        <div className={styles.row}>
          {cameras.filter((c) => (c.state as CameraState).online).length} camera{cameras.length > 1 ? "s" : ""}
        </div>
      )}
    </Card>
  );
}
