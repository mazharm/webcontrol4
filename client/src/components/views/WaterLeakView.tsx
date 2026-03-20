import { useState, useEffect, useCallback, useMemo } from "react";
import {
  makeStyles,
  tokens,
  Text,
  Card,
  Badge,
  Spinner,
  Button,
  Dropdown,
  Option,
  OptionGroup,
} from "@fluentui/react-components";
import {
  Drop24Regular,
  Warning24Filled,
  QuestionCircle24Regular,
} from "@fluentui/react-icons";
import { useGoveeSensors } from "../../hooks/useGoveeSensors";
import { useFloorTree } from "../../hooks/useDevices";
import { getSettings, saveGoveeSensorRooms } from "../../api/settings";
import type { GoveeSensor, SettingsResponse } from "../../types/api";

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

const useStyles = makeStyles({
  root: { maxWidth: "1200px" },
  title: {
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightSemibold,
    marginBottom: "16px",
  },
  summary: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "16px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: "12px",
  },
  card: { padding: "14px" },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "8px",
  },
  leakIcon: { color: "#ef4444" },
  clearIcon: { color: "#22c55e" },
  staleIcon: { color: "#f59e0b" },
  name: {
    flex: 1,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  details: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginTop: "6px",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
  roomRow: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    marginTop: "8px",
  },
  roomLabel: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
  },
  roomValue: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  empty: {
    textAlign: "center",
    padding: "40px 20px",
    color: tokens.colorNeutralForeground3,
  },
});

type SensorStatus = "leak" | "clear" | "stale" | "unknown";

function getSensorStatus(sensor: GoveeSensor): SensorStatus {
  if (sensor.leakDetected) return "leak";
  if (!sensor.lastTime) return "unknown";
  const ts = sensor.lastTime > 1e12 ? sensor.lastTime : sensor.lastTime * 1000;
  if (Date.now() - ts > STALE_THRESHOLD_MS) return "stale";
  return "clear";
}

function formatLastTime(ts: number | null): string {
  if (!ts) return "Never";
  const d = new Date(ts > 1e12 ? ts : ts * 1000);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}

const STATUS_CONFIG: Record<SensorStatus, { icon: JSX.Element; badge: string; badgeColor: "danger" | "success" | "warning"; iconClass: string }> = {
  leak:    { icon: <Warning24Filled />,       badge: "LEAK",    badgeColor: "danger",  iconClass: "leakIcon" },
  clear:   { icon: <Drop24Regular />,         badge: "Dry",     badgeColor: "success", iconClass: "clearIcon" },
  stale:   { icon: <QuestionCircle24Regular />, badge: "Stale",   badgeColor: "warning", iconClass: "staleIcon" },
  unknown: { icon: <QuestionCircle24Regular />, badge: "Pending", badgeColor: "warning", iconClass: "staleIcon" },
};

interface RoomOption {
  value: string;
  label: string;
  floor: string;
}

function SensorCard({
  sensor,
  room,
  roomOptions,
  onRoomChange,
}: {
  sensor: GoveeSensor;
  room: string;
  roomOptions: RoomOption[];
  onRoomChange: (id: string, room: string) => void;
}) {
  const styles = useStyles();
  const status = getSensorStatus(sensor);
  const config = STATUS_CONFIG[status];

  // Group room options by floor
  const floorGroups = useMemo(() => {
    const groups = new Map<string, RoomOption[]>();
    for (const opt of roomOptions) {
      const floor = opt.floor || "Other";
      if (!groups.has(floor)) groups.set(floor, []);
      groups.get(floor)!.push(opt);
    }
    return groups;
  }, [roomOptions]);

  return (
    <Card className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles[config.iconClass as keyof typeof styles] as string}>
          {config.icon}
        </span>
        <Text className={styles.name} truncate wrap={false}>
          {sensor.name}
        </Text>
        <Badge appearance="filled" color={config.badgeColor}>
          {config.badge}
        </Badge>
      </div>
      <div className={styles.details}>
        {sensor.battery != null && <span>Battery: {sensor.battery}%</span>}
        <span>Last check: {formatLastTime(sensor.lastTime)}</span>
        <span>Model: {sensor.sku}</span>
      </div>
      <div className={styles.roomRow}>
        <span className={styles.roomLabel}>Space:</span>
        <Dropdown
          size="small"
          value={room || "Unassigned"}
          selectedOptions={room ? [room] : []}
          onOptionSelect={(_, d) => {
            const val = d.optionValue ?? "";
            onRoomChange(sensor.id, val === "__unassign__" ? "" : val);
          }}
          style={{ flex: 1, minWidth: 0 }}
        >
          <Option value="__unassign__" text="Unassigned">
            <Text style={{ fontStyle: "italic" }}>Unassigned</Text>
          </Option>
          {Array.from(floorGroups.entries()).map(([floor, opts]) => (
            <OptionGroup key={floor} label={floor}>
              {opts.map((o) => (
                <Option key={o.value} value={o.value} text={o.label}>
                  {o.label}
                </Option>
              ))}
            </OptionGroup>
          ))}
        </Dropdown>
      </div>
    </Card>
  );
}

export function WaterLeakView() {
  const styles = useStyles();
  const { sensors, anyLeak, loading } = useGoveeSensors();
  const floorTree = useFloorTree();
  const [rooms, setRooms] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<SettingsResponse | null>(null);

  // Build room options from floor/room taxonomy
  const roomOptions = useMemo<RoomOption[]>(() => {
    const opts: RoomOption[] = [];
    for (const floor of floorTree) {
      for (const room of floor.rooms) {
        opts.push({
          value: `${floor.name} > ${room.name}`,
          label: room.name,
          floor: floor.name,
        });
      }
    }
    return opts;
  }, [floorTree]);

  useEffect(() => {
    getSettings()
      .then((s) => {
        setSettings(s);
        setRooms(s.goveeSensorRooms || {});
      })
      .catch(() => {});
  }, []);

  const handleRoomChange = useCallback(
    async (sensorId: string, room: string) => {
      const prev = rooms;
      const updated = { ...rooms, [sensorId]: room };
      setRooms(updated);
      try {
        await saveGoveeSensorRooms(updated);
      } catch {
        setRooms(prev);
      }
    },
    [rooms]
  );

  if (loading) return <Spinner label="Loading sensors..." />;

  if (!settings?.goveeConnected) {
    return (
      <div className={styles.root}>
        <Text className={styles.title}>Water Leak Sensors</Text>
        <div className={styles.empty}>
          <Drop24Regular style={{ fontSize: 48, marginBottom: 12 }} />
          <Text block>
            Govee is not connected. Go to Settings to sign in.
          </Text>
        </div>
      </div>
    );
  }

  // Summary status considers stale/unknown sensors
  const hasStale = sensors.some((s) => {
    const st = getSensorStatus(s);
    return st === "stale" || st === "unknown";
  });
  const summaryColor = anyLeak ? "danger" : hasStale ? "warning" : "success";
  const summaryLabel = anyLeak ? "LEAK DETECTED" : hasStale ? "Check Needed" : "All Clear";

  return (
    <div className={styles.root}>
      <Text className={styles.title}>Water Leak Sensors</Text>
      <div className={styles.summary}>
        <Badge appearance="filled" color={summaryColor} size="large">
          {summaryLabel}
        </Badge>
        <Text>
          {sensors.length} sensor{sensors.length !== 1 ? "s" : ""}
        </Text>
      </div>
      {sensors.length === 0 ? (
        <div className={styles.empty}>
          <Text>No sensors discovered yet. They will appear after the next poll cycle.</Text>
        </div>
      ) : (
        <div className={styles.grid}>
          {sensors.map((s) => (
            <SensorCard
              key={s.id}
              sensor={s}
              room={rooms[s.id] || ""}
              roomOptions={roomOptions}
              onRoomChange={handleRoomChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}
