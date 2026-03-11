import type { UnifiedDevice } from "../../types/devices";
import { LightCard } from "./LightCard";
import { ThermostatCard } from "./ThermostatCard";
import { LockCard } from "./LockCard";
import { SensorCard } from "./SensorCard";
import { CameraCard } from "./CameraCard";
import { SecurityCard } from "./SecurityCard";
import { MediaCard } from "./MediaCard";

interface DeviceCardProps {
  device: UnifiedDevice;
}

export function DeviceCard({ device }: DeviceCardProps) {
  switch (device.type) {
    case "light":
      return <LightCard device={device} />;
    case "thermostat":
      return <ThermostatCard device={device} />;
    case "lock":
      return <LockCard device={device} />;
    case "sensor":
      return <SensorCard device={device} />;
    case "camera":
      return <CameraCard device={device} />;
    case "security":
      return <SecurityCard device={device} />;
    case "media":
      return <MediaCard device={device} />;
    default:
      return null;
  }
}
