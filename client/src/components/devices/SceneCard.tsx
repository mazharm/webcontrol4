import { useCallback, useState } from "react";
import { Button } from "@fluentui/react-components";
import { Play24Regular } from "@fluentui/react-icons";
import type { Scene } from "../../types/devices";
import { useAuth } from "../../contexts/AuthContext";
import { sendCommand } from "../../api/director";

interface SceneCardProps {
  scene: Scene;
}

export function SceneCard({ scene }: SceneCardProps) {
  const { state: auth } = useAuth();
  const [running, setRunning] = useState(false);

  const activate = useCallback(async () => {
    setRunning(true);
    try {
      await sendCommand(
        { ip: auth.controllerIp || "", token: auth.directorToken || "" },
        scene.id,
        "ACTIVATE",
      );
    } catch { /* ignore */ }
    setTimeout(() => setRunning(false), 1500);
  }, [scene.id, auth]);

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
