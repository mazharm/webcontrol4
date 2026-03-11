import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { makeStyles, tokens, Text } from "@fluentui/react-components";
import { useDevicesByRoom } from "../../hooks/useDevices";
import { useDeviceContext } from "../../contexts/DeviceContext";
import { DeviceCard } from "../devices/DeviceCard";
import { SceneCard } from "../devices/SceneCard";

const useStyles = makeStyles({
  root: { maxWidth: "1200px" },
  header: {
    display: "flex",
    alignItems: "baseline",
    gap: "12px",
    marginBottom: "16px",
  },
  title: {
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightSemibold,
  },
  floor: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground3,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
    gap: "12px",
  },
  sceneSection: {
    marginTop: "20px",
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    paddingTop: "12px",
  },
  sceneLabel: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground3,
    marginBottom: "8px",
  },
  sceneRow: {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
  },
});

export function RoomView() {
  const styles = useStyles();
  const { roomId } = useParams<{ roomId: string }>();
  const rid = parseInt(roomId || "0", 10);
  const devices = useDevicesByRoom(rid);
  const { state } = useDeviceContext();

  const roomName = devices[0]?.roomName || "Room";
  const floorName = devices[0]?.floorName || "";

  const scenes = useMemo(
    () => state.scenes.filter((s) => s.roomId === rid),
    [state.scenes, rid]
  );

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Text className={styles.title}>{roomName}</Text>
        {floorName && <Text className={styles.floor}>{floorName}</Text>}
      </div>
      <div className={styles.grid}>
        {devices.map((device) => (
          <DeviceCard key={device.id} device={device} />
        ))}
      </div>
      {scenes.length > 0 && (
        <div className={styles.sceneSection}>
          <div className={styles.sceneLabel}>Scenes</div>
          <div className={styles.sceneRow}>
            {scenes.map((scene) => (
              <SceneCard key={scene.id} scene={scene} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
