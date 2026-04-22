import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@fluentui/react-components";
import { Play24Regular } from "@fluentui/react-icons";
import type { Scene } from "../../types/devices";
import { useAuth } from "../../contexts/AuthContext";
import { sendCommand } from "../../api/director";
import { sendDeviceCommand } from "../../services/device-commands";
import { isRemoteMode } from "../../config/transport";

interface SceneCardProps {
  scene: Scene;
}

export function SceneCard({ scene }: SceneCardProps) {
  const { state: auth } = useAuth();
  const [running, setRunning] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const remote = isRemoteMode();

  const activate = useCallback(async () => {
    setRunning(true);
    try {
      if (remote) {
        await sendDeviceCommand("control4", scene.id, { on: true });
      } else {
        await sendCommand(
          { ip: auth.controllerIp || "", token: auth.directorToken || "" },
          scene.id,
          "ACTIVATE",
        );
      }
    } catch { /* ignore */ }
    timerRef.current = setTimeout(() => setRunning(false), 1500);
  }, [scene.id, auth, remote]);

  return (
    <Button
      size="small"
      appearance="outline"
      icon={<Play24Regular />}
      onClick={activate}
      disabled={running}
    >
      {scene.name}
    </Button>
  );
}
