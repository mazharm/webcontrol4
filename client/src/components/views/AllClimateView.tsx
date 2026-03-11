import { useMemo } from "react";
import { makeStyles, tokens, Text } from "@fluentui/react-components";
import { useDevicesByType } from "../../hooks/useDevices";
import { ThermostatCard } from "../devices/ThermostatCard";

const useStyles = makeStyles({
  root: { maxWidth: "1200px" },
  title: {
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightSemibold,
    marginBottom: "16px",
  },
  floorSection: { marginBottom: "20px" },
  floorHeader: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase400,
    marginBottom: "8px",
    paddingBottom: "4px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  roomLabel: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground3,
    marginBottom: "6px",
    marginTop: "8px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
    gap: "12px",
    marginBottom: "12px",
  },
});

export function AllClimateView() {
  const styles = useStyles();
  const thermostats = useDevicesByType("thermostat");

  const grouped = useMemo(() => {
    const map = new Map<string, Map<string, typeof thermostats>>();
    for (const d of thermostats) {
      const floor = d.floorName || "Other";
      if (!map.has(floor)) map.set(floor, new Map());
      const rooms = map.get(floor)!;
      const room = d.roomName || "Unknown";
      if (!rooms.has(room)) rooms.set(room, []);
      rooms.get(room)!.push(d);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [thermostats]);

  return (
    <div className={styles.root}>
      <Text className={styles.title}>All Climate</Text>
      {grouped.map(([floorName, rooms]) => (
        <div key={floorName} className={styles.floorSection}>
          <div className={styles.floorHeader}>{floorName}</div>
          {Array.from(rooms.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([roomName, devs]) => (
            <div key={roomName}>
              <div className={styles.roomLabel}>{roomName}</div>
              <div className={styles.grid}>
                {devs.map((d) => <ThermostatCard key={d.id} device={d} />)}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
