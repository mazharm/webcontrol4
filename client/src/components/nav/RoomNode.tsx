import { useNavigate, useLocation } from "react-router-dom";
import { makeStyles, tokens } from "@fluentui/react-components";
import type { RoomNode } from "../../types/devices";

const useStyles = makeStyles({
  root: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "4px 8px",
    cursor: "pointer",
    fontSize: tokens.fontSizeBase300,
    borderRadius: tokens.borderRadiusMedium,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground3,
    },
  },
  active: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
  label: { flex: 1 },
  meta: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
});

interface RoomNodeProps {
  room: RoomNode;
  onNavigate: () => void;
}

export function RoomNodeComponent({ room, onNavigate }: RoomNodeProps) {
  const styles = useStyles();
  const navigate = useNavigate();
  const location = useLocation();
  const isActive = location.pathname === `/room/${room.id}`;

  const meta = room.lightsOn > 0
    ? `${room.lightsOn} on`
    : room.tempF != null
    ? `${Math.round(room.tempF)}°`
    : room.hasCamera
    ? "cam"
    : "";

  return (
    <div
      className={`${styles.root} ${isActive ? styles.active : ""}`}
      onClick={() => {
        navigate(`/room/${room.id}`);
        onNavigate();
      }}
    >
      <span className={styles.label}>{room.name}</span>
      {meta && <span className={styles.meta}>{meta}</span>}
    </div>
  );
}
