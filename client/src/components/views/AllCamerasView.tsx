import { useMemo } from "react";
import { makeStyles, tokens, Text } from "@fluentui/react-components";
import { useDevicesByType } from "../../hooks/useDevices";
import { DeviceCard } from "../devices/DeviceCard";

const useStyles = makeStyles({
  root: { maxWidth: "1200px" },
  title: {
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightSemibold,
    marginBottom: "16px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: "12px",
  },
  empty: {
    color: tokens.colorNeutralForeground3,
    padding: "24px 0",
  },
});

export function AllCamerasView() {
  const styles = useStyles();
  const cameras = useDevicesByType("camera");
  const sorted = useMemo(() => [...cameras].sort((a, b) => a.name.localeCompare(b.name)), [cameras]);

  return (
    <div className={styles.root}>
      <Text className={styles.title}>All Cameras</Text>
      {sorted.length === 0 ? (
        <Text className={styles.empty}>No cameras available.</Text>
      ) : (
        <div className={styles.grid}>
          {sorted.map((device) => <DeviceCard key={device.id} device={device} />)}
        </div>
      )}
    </div>
  );
}
