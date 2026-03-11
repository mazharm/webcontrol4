import { useMemo } from "react";
import { makeStyles, tokens, Text } from "@fluentui/react-components";
import { useDevices } from "../../hooks/useDevices";
import { DeviceCard } from "../devices/DeviceCard";
import type { UnifiedDevice } from "../../types/devices";

const useStyles = makeStyles({
  root: { maxWidth: "1200px" },
  title: {
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightSemibold,
    marginBottom: "16px",
  },
  section: {
    marginBottom: "20px",
  },
  sectionTitle: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase400,
    marginBottom: "8px",
    paddingBottom: "4px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
    gap: "12px",
  },
});

export function AllSecurityView() {
  const styles = useStyles();
  const { devices } = useDevices();

  const { securityDevices, lockDevices, sensorDevices } = useMemo(() => {
    const sec: UnifiedDevice[] = [];
    const locks: UnifiedDevice[] = [];
    const sensors: UnifiedDevice[] = [];
    for (const d of devices.values()) {
      if (d.type === "security") sec.push(d);
      else if (d.type === "lock") locks.push(d);
      else if (d.type === "sensor") sensors.push(d);
    }
    return { securityDevices: sec, lockDevices: locks, sensorDevices: sensors };
  }, [devices]);

  return (
    <div className={styles.root}>
      <Text className={styles.title}>All Security</Text>
      {securityDevices.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Alarm Systems</div>
          <div className={styles.grid}>
            {securityDevices.map((d) => <DeviceCard key={d.id} device={d} />)}
          </div>
        </div>
      )}
      {lockDevices.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Locks</div>
          <div className={styles.grid}>
            {lockDevices.map((d) => <DeviceCard key={d.id} device={d} />)}
          </div>
        </div>
      )}
      {sensorDevices.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Sensors</div>
          <div className={styles.grid}>
            {sensorDevices.map((d) => <DeviceCard key={d.id} device={d} />)}
          </div>
        </div>
      )}
    </div>
  );
}
