import { useState, useEffect, useCallback } from "react";
import {
  makeStyles,
  tokens,
  Text,
  TabList,
  Tab,
  Dropdown,
  Option,
  Spinner,
} from "@fluentui/react-components";
import { useDevicesByType } from "../../hooks/useDevices";
import { useFloorTree } from "../../hooks/useDevices";
import { getHistory } from "../../api/history";
import { LightHistoryChart } from "./LightHistoryChart";
import { TempHistoryChart } from "./TempHistoryChart";
import { FloorActivityChart } from "./FloorActivityChart";
import type { FloorHistorySeries, HistoryPoint } from "../../types/api";

const useStyles = makeStyles({
  root: { maxWidth: "1000px" },
  title: {
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightSemibold,
    marginBottom: "16px",
  },
  controls: {
    display: "flex",
    gap: "12px",
    alignItems: "center",
    marginBottom: "16px",
    flexWrap: "wrap",
  },
  chart: { marginTop: "16px" },
  empty: {
    padding: "40px",
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
  },
});

type HistoryTab = "lights" | "temperature" | "floor";

export function HistoryView() {
  const styles = useStyles();
  const [tab, setTab] = useState<HistoryTab>("lights");
  const [selectedId, setSelectedId] = useState<string>("");
  const [data, setData] = useState<HistoryPoint[]>([]);
  const [floorData, setFloorData] = useState<FloorHistorySeries[]>([]);
  const [loading, setLoading] = useState(false);

  const lights = useDevicesByType("light");
  const thermostats = useDevicesByType("thermostat");
  const floors = useFloorTree();

  // Select first device by default
  useEffect(() => {
    if (tab === "lights" && lights.length > 0 && !selectedId) {
      setSelectedId(lights[0].id.replace("control4:", ""));
    } else if (tab === "temperature" && thermostats.length > 0 && !selectedId) {
      setSelectedId(thermostats[0].id.replace("control4:", ""));
    }
  }, [tab, lights, thermostats, floors, selectedId]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === "floor") {
        const result = await Promise.all(
          floors.map(async (floor) => ({
            floor: floor.name,
            points: await getHistory("floor", floor.name),
          })),
        );
        setFloorData(result);
        setData([]);
      } else {
        if (!selectedId) {
          setData([]);
          setFloorData([]);
          return;
        }
        const type = tab === "lights" ? "light" : "thermo";
        const result = await getHistory(type, selectedId);
        setData(result);
        setFloorData([]);
      }
    } catch {
      setData([]);
      setFloorData([]);
    } finally {
      setLoading(false);
    }
  }, [floors, selectedId, tab]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const onTabChange = (_: unknown, data: { value: unknown }) => {
    setTab(data.value as HistoryTab);
    setSelectedId("");
    setData([]);
    setFloorData([]);
  };

  const deviceOptions = tab === "lights"
    ? lights.map((d) => ({ id: d.id.replace("control4:", ""), name: d.name }))
    : tab === "temperature"
    ? thermostats.map((d) => ({ id: d.id.replace("control4:", ""), name: d.name }))
    : [];

  const hasFloorData = floorData.some((series) => series.points.length > 0);

  return (
    <div className={styles.root}>
      <Text className={styles.title}>History</Text>
      <TabList selectedValue={tab} onTabSelect={onTabChange as never}>
        <Tab value="lights">Light States</Tab>
        <Tab value="temperature">Temperature</Tab>
        <Tab value="floor">Floor Activity</Tab>
      </TabList>
      {tab !== "floor" && (
        <div className={styles.controls}>
          <Dropdown
            value={deviceOptions.find((o) => o.id === selectedId)?.name || "Select..."}
            selectedOptions={selectedId ? [selectedId] : []}
            onOptionSelect={(_, d) => d.optionValue && setSelectedId(d.optionValue)}
            style={{ minWidth: "200px" }}
          >
            {deviceOptions.map((opt) => (
              <Option key={opt.id} value={opt.id}>{opt.name}</Option>
            ))}
          </Dropdown>
        </div>
      )}
      <div className={styles.chart}>
        {loading ? (
          <Spinner label="Loading history..." />
        ) : tab === "floor" ? (
          hasFloorData ? (
            <FloorActivityChart data={floorData} />
          ) : (
            <div className={styles.empty}>No history data available</div>
          )
        ) : data.length === 0 ? (
          <div className={styles.empty}>No history data available</div>
        ) : tab === "lights" ? (
          <LightHistoryChart data={data} />
        ) : (
          <TempHistoryChart data={data} />
        )}
      </div>
    </div>
  );
}
