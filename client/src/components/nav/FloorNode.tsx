import { useState } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import { ChevronDown20Regular, ChevronRight20Regular } from "@fluentui/react-icons";
import { RoomNodeComponent } from "./RoomNode";
import type { FloorNode } from "../../types/devices";

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "10px 8px",
    cursor: "pointer",
    userSelect: "none",
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
    borderRadius: tokens.borderRadiusMedium,
    minHeight: "44px",
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground3,
    },
  },
  label: { flex: 1 },
  count: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  children: {
    paddingLeft: "12px",
  },
});

interface FloorNodeProps {
  floor: FloorNode;
  onNavigate: () => void;
}

export function FloorNodeComponent({ floor, onNavigate }: FloorNodeProps) {
  const styles = useStyles();
  const [expanded, setExpanded] = useState(floor.isExpanded);
  const lightsOn = floor.rooms.reduce((sum, r) => sum + r.lightsOn, 0);

  return (
    <div>
      <div className={styles.header} onClick={() => setExpanded((e) => !e)}>
        {expanded ? <ChevronDown20Regular /> : <ChevronRight20Regular />}
        <span className={styles.label}>{floor.name}</span>
        {lightsOn > 0 && <span className={styles.count}>{lightsOn} on</span>}
      </div>
      {expanded && (
        <div className={styles.children}>
          {floor.rooms.map((room) => (
            <RoomNodeComponent key={room.id} room={room} onNavigate={onNavigate} />
          ))}
        </div>
      )}
    </div>
  );
}
