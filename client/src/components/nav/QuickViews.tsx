import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { makeStyles, tokens, Badge, Button } from "@fluentui/react-components";
import {
  Home24Regular,
  Lightbulb24Regular,
  Temperature24Regular,
  ShieldLock24Regular,
  Video24Regular,
  Drop24Regular,
  ChevronDown20Regular,
  ChevronRight20Regular,
} from "@fluentui/react-icons";
import { useDevicesByType } from "../../hooks/useDevices";
import { useGoveeSensors } from "../../hooks/useGoveeSensors";
import type { LightState, CameraState } from "../../types/devices";

const useStyles = makeStyles({
  root: {
    padding: "8px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "4px 8px",
    cursor: "pointer",
    userSelect: "none",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "10px 8px",
    borderRadius: tokens.borderRadiusMedium,
    cursor: "pointer",
    fontSize: tokens.fontSizeBase300,
    minHeight: "44px",
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground3,
    },
  },
  active: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
  label: { flex: 1 },
});

interface QuickViewsProps {
  onNavigate: () => void;
}

export function QuickViews({ onNavigate }: QuickViewsProps) {
  const styles = useStyles();
  const [expanded, setExpanded] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();

  const lights = useDevicesByType("light");
  const thermostats = useDevicesByType("thermostat");
  const security = useDevicesByType("security");
  const cameras = useDevicesByType("camera");

  const { sensors: goveeSensors, anyLeak } = useGoveeSensors();

  const lightsOn = lights.filter((d) => (d.state as LightState).on).length;
  const camerasOnline = cameras.filter((d) => (d.state as CameraState).online).length;

  const STALE_MS = 24 * 60 * 60 * 1000;
  const hasStaleOrUnknown = goveeSensors.some((s) => {
    if (s.leakDetected) return false;
    if (!s.lastTime) return true;
    const ts = s.lastTime > 1e12 ? s.lastTime : s.lastTime * 1000;
    return Date.now() - ts > STALE_MS;
  });
  const leakBadgeColor: "danger" | "warning" | "brand" = anyLeak ? "danger" : hasStaleOrUnknown ? "warning" : "brand";
  const leakBadgeText = anyLeak ? "!" : hasStaleOrUnknown ? "?" : goveeSensors.length;

  const nav = (path: string) => {
    navigate(path);
    onNavigate();
  };

  const items = [
    { path: "/", label: "Home", icon: <Home24Regular />, badge: null, alwaysShow: true },
    { path: "/lights", label: "All Lights", icon: <Lightbulb24Regular />, badge: lightsOn || null },
    { path: "/climate", label: "All Climate", icon: <Temperature24Regular />, badge: thermostats.length || null },
    { path: "/security", label: "All Security", icon: <ShieldLock24Regular />, badge: security.length || null },
    { path: "/cameras", label: "All Cameras", icon: <Video24Regular />, badge: camerasOnline || null },
    ...(goveeSensors.length > 0
      ? [{ path: "/water-leak", label: "Water Leak", icon: <Drop24Regular />, badge: leakBadgeText, badgeColor: leakBadgeColor }]
      : []),
  ];

  return (
    <div className={styles.root}>
      <div className={styles.header} onClick={() => setExpanded((e) => !e)}>
        <span>Quick Views</span>
        {expanded ? <ChevronDown20Regular /> : <ChevronRight20Regular />}
      </div>
      {/* Home is always visible */}
      <div
        className={`${styles.item} ${location.pathname === "/" ? styles.active : ""}`}
        onClick={() => nav("/")}
      >
        <Home24Regular />
        <span className={styles.label}>Home</span>
      </div>
      {expanded && items.filter((i) => !i.alwaysShow).map((item) => (
        <div
          key={item.path}
          className={`${styles.item} ${location.pathname === item.path ? styles.active : ""}`}
          onClick={() => nav(item.path)}
        >
          {item.icon}
          <span className={styles.label}>{item.label}</span>
          {item.badge != null && (
            <Badge appearance="filled" color={(item as { badgeColor?: string }).badgeColor as "brand" | "danger" || "brand"} size="small">
              {item.badge}
            </Badge>
          )}
        </div>
      ))}
    </div>
  );
}
