import { useMemo } from "react";
import { useDeviceContext } from "../contexts/DeviceContext";
import type { UnifiedDevice, FloorNode, RoomNode } from "../types/devices";

export function useDevices() {
  const { state } = useDeviceContext();
  return state;
}

export function useDevicesByType(type: UnifiedDevice["type"]): UnifiedDevice[] {
  const { state } = useDeviceContext();
  return useMemo(
    () => Array.from(state.devices.values()).filter((d) => d.type === type),
    [state.devices, type]
  );
}

export function useDevicesByRoom(roomId: number): UnifiedDevice[] {
  const { state } = useDeviceContext();
  return useMemo(
    () => Array.from(state.devices.values()).filter((d) => (d.roomId ?? 0) === roomId),
    [state.devices, roomId]
  );
}

export function useFloorTree(): FloorNode[] {
  const { state } = useDeviceContext();
  return useMemo(() => {
    const floorMap = new Map<string, Map<number, RoomNode>>();
    for (const device of state.devices.values()) {
      if (device.zoneName) continue; // zones handled separately
      const floor = device.floorName || "Unknown";
      if (!floorMap.has(floor)) floorMap.set(floor, new Map());
      const rooms = floorMap.get(floor)!;
      const roomId = device.roomId ?? 0;
      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          id: roomId,
          name: device.roomName || "Unknown",
          lightsOn: 0,
          totalLights: 0,
          tempF: null,
          hasCamera: false,
        });
      }
      const room = rooms.get(roomId)!;
      if (device.type === "light") {
        room.totalLights++;
        if ((device.state as { on: boolean }).on) room.lightsOn++;
      }
      if (device.type === "thermostat") {
        room.tempF = (device.state as { currentTempF: number }).currentTempF;
      }
      if (device.type === "camera") {
        room.hasCamera = true;
      }
    }

    const floors: FloorNode[] = [];
    for (const [name, rooms] of floorMap) {
      floors.push({
        name,
        rooms: Array.from(rooms.values()).sort((a, b) => a.name.localeCompare(b.name)),
        isExpanded: true,
      });
    }
    return floors.sort((a, b) => a.name.localeCompare(b.name));
  }, [state.devices]);
}

export function useZoneDevices(): UnifiedDevice[] {
  const { state } = useDeviceContext();
  return useMemo(
    () => Array.from(state.devices.values()).filter((d) => d.zoneName != null),
    [state.devices]
  );
}

export function useDeviceSummary(): string {
  const { state } = useDeviceContext();
  return useMemo(() => {
    const lines: string[] = [];
    const byRoom = new Map<string, UnifiedDevice[]>();
    for (const d of state.devices.values()) {
      const key = d.roomName || "Unknown";
      if (!byRoom.has(key)) byRoom.set(key, []);
      byRoom.get(key)!.push(d);
    }
    for (const [room, devices] of byRoom) {
      const parts: string[] = [];
      for (const d of devices) {
        if (d.type === "light") {
          const s = d.state as { on: boolean; level: number };
          parts.push(`${d.name}: ${s.on ? `ON ${s.level}%` : "OFF"}`);
        } else if (d.type === "thermostat") {
          const s = d.state as { currentTempF: number; hvacMode: string };
          parts.push(`${d.name}: ${s.currentTempF}°F ${s.hvacMode}`);
        } else if (d.type === "lock") {
          const s = d.state as { locked: boolean };
          parts.push(`${d.name}: ${s.locked ? "Locked" : "Unlocked"}`);
        }
      }
      if (parts.length) lines.push(`${room}: ${parts.join(", ")}`);
    }
    return lines.join("\n");
  }, [state.devices]);
}
