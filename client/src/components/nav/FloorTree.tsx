import { makeStyles, tokens } from "@fluentui/react-components";
import { FloorNodeComponent } from "./FloorNode";
import { useFloorTree, useZoneDevices } from "../../hooks/useDevices";
import type { RoomNode } from "../../types/devices";

const useStyles = makeStyles({
  root: {
    padding: "8px",
  },
  sectionLabel: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    padding: "8px 8px 4px",
  },
});

interface FloorTreeProps {
  onNavigate: () => void;
}

export function FloorTree({ onNavigate }: FloorTreeProps) {
  const styles = useStyles();
  const floors = useFloorTree();
  const zoneDevices = useZoneDevices();

  // Build outdoor zone rooms
  const outdoorRooms = new Map<string, RoomNode>();
  for (const d of zoneDevices) {
    const roomName = d.roomName || "Outdoor";
    if (!outdoorRooms.has(roomName)) {
      outdoorRooms.set(roomName, {
        id: d.roomId ?? -1,
        name: roomName,
        lightsOn: 0,
        totalLights: 0,
        tempF: null,
        hasCamera: d.type === "camera",
      });
    }
    const room = outdoorRooms.get(roomName)!;
    if (d.type === "camera") room.hasCamera = true;
  }

  return (
    <div className={styles.root}>
      <div className={styles.sectionLabel}>Spaces</div>
      {floors.map((floor) => (
        <FloorNodeComponent key={floor.name} floor={{ ...floor, isExpanded: false }} onNavigate={onNavigate} />
      ))}
      {outdoorRooms.size > 0 && (
        <FloorNodeComponent
          floor={{ name: "Outdoor", rooms: Array.from(outdoorRooms.values()), isExpanded: false }}
          onNavigate={onNavigate}
        />
      )}
    </div>
  );
}
