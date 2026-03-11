import { useMemo } from "react";
import { makeStyles, tokens, Text } from "@fluentui/react-components";
import { useDevicesByType } from "../../hooks/useDevices";
import { LightCard } from "../devices/LightCard";
import type { LightState } from "../../types/devices";

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
  count: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground3,
  },
  floorSection: {
    marginBottom: "20px",
  },
  floorHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "8px",
    paddingBottom: "4px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  floorName: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase400,
  },
  floorCount: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  roomLabel: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground3,
    marginBottom: "6px",
    marginTop: "8px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
    gap: "12px",
    marginBottom: "12px",
  },
});

export function AllLightsView() {
  const styles = useStyles();
  const lights = useDevicesByType("light");

  const onCount = lights.filter((d) => (d.state as LightState).on).length;

  const grouped = useMemo(() => {
    const floorMap = new Map<string, Map<string, typeof lights>>();
    for (const d of lights) {
      const floor = d.floorName || d.zoneName || "Other";
      if (!floorMap.has(floor)) floorMap.set(floor, new Map());
      const rooms = floorMap.get(floor)!;
      const room = d.roomName || "Unknown";
      if (!rooms.has(room)) rooms.set(room, []);
      rooms.get(room)!.push(d);
    }
    return Array.from(floorMap.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [lights]);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Text className={styles.title}>All Lights</Text>
        <Text className={styles.count}>{onCount} on / {lights.length}</Text>
      </div>
      {grouped.map(([floorName, rooms]) => {
        const floorOn = Array.from(rooms.values())
          .flat()
          .filter((d) => (d.state as LightState).on).length;
        return (
          <div key={floorName} className={styles.floorSection}>
            <div className={styles.floorHeader}>
              <Text className={styles.floorName}>{floorName}</Text>
              <Text className={styles.floorCount}>{floorOn} on</Text>
            </div>
            {Array.from(rooms.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([roomName, devs]) => (
              <div key={roomName}>
                <div className={styles.roomLabel}>{roomName}</div>
                <div className={styles.grid}>
                  {devs.map((d) => <LightCard key={d.id} device={d} />)}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
