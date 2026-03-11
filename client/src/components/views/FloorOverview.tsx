import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { makeStyles, tokens, Text } from "@fluentui/react-components";
import { useDevices } from "../../hooks/useDevices";
import { RoomSummaryCard } from "../dashboard/RoomSummaryCard";
import type { UnifiedDevice } from "../../types/devices";

const useStyles = makeStyles({
  root: { maxWidth: "1200px" },
  title: {
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightSemibold,
    marginBottom: "16px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: "12px",
  },
});

export function FloorOverview() {
  const styles = useStyles();
  const { floorName } = useParams<{ floorName: string }>();
  const { devices } = useDevices();

  const roomGroups = useMemo(() => {
    const map = new Map<number, { name: string; devices: UnifiedDevice[] }>();
    for (const d of devices.values()) {
      if (d.floorName !== floorName) continue;
      const roomId = d.roomId ?? 0;
      if (!map.has(roomId)) map.set(roomId, { name: d.roomName, devices: [] });
      map.get(roomId)!.devices.push(d);
    }
    return Array.from(map.entries()).sort(([, a], [, b]) => a.name.localeCompare(b.name));
  }, [devices, floorName]);

  return (
    <div className={styles.root}>
      <Text className={styles.title}>{floorName}</Text>
      <div className={styles.grid}>
        {roomGroups.map(([roomId, { name, devices: roomDevices }]) => (
          <RoomSummaryCard key={roomId} roomId={roomId} roomName={name} devices={roomDevices} />
        ))}
      </div>
    </div>
  );
}
