import { useState, useCallback, useEffect } from "react";
import {
  makeStyles,
  tokens,
  Card,
  Text,
  Button,
  Badge,
} from "@fluentui/react-components";
import {
  Video24Regular,
  Flashlight24Regular,
  Alert24Regular,
} from "@fluentui/react-icons";
import type { UnifiedDevice, CameraState } from "../../types/devices";
import { toggleCameraLight, toggleCameraSiren } from "../../api/ring";
import { isRemoteMode } from "../../config/transport";
import { getSnapshot } from "../../services/mqtt-rpc";
import { sendDeviceCommand } from "../../services/device-commands";
import { getCached, setCache } from "../../services/rpc-cache";

const useStyles = makeStyles({
  card: { padding: "12px", minWidth: "220px" },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "8px",
  },
  name: {
    flex: 1,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  snapshot: {
    width: "100%",
    borderRadius: tokens.borderRadiusMedium,
    marginBottom: "8px",
    backgroundColor: tokens.colorNeutralBackground3,
    minHeight: "120px",
    objectFit: "cover",
  },
  controls: {
    display: "flex",
    gap: "8px",
    marginTop: "8px",
  },
});

export function CameraCard({ device }: { device: UnifiedDevice }) {
  const styles = useStyles();
  const cs = device.state as CameraState;
  const ringId = device.id.replace("ring:", "");
  const [imgError, setImgError] = useState(false);
  const remote = isRemoteMode();
  const cacheKey = `snapshot:${ringId}`;
  const [remoteSnapshotUrl, setRemoteSnapshotUrl] = useState<string | null>(
    () => getCached<string>(cacheKey) ?? null,
  );

  // In remote mode, fetch snapshot via MQTT RPC (only for online cameras)
  useEffect(() => {
    if (!remote || !cs.online) return;
    let cancelled = false;
    getSnapshot(ringId)
      .then((result) => {
        if (!cancelled) {
          setRemoteSnapshotUrl(result.image);
          setCache(cacheKey, result.image);
          setImgError(false);
        }
      })
      .catch(() => {
        // Only show error if there's no cached image to fall back on
        if (!cancelled && !getCached(cacheKey)) setImgError(true);
      });
    return () => { cancelled = true; };
  }, [remote, ringId, cs.online, cacheKey]);

  const snapshotSrc = remote ? remoteSnapshotUrl : cs.snapshotUrl;

  const onToggleLight = useCallback(async () => {
    try {
      if (remote) {
        await sendDeviceCommand("ring", ringId, { light: !cs.lightOn });
      } else {
        await toggleCameraLight(ringId, !cs.lightOn);
      }
    } catch { /* ignore */ }
  }, [remote, ringId, cs.lightOn]);

  const onToggleSiren = useCallback(async () => {
    try {
      if (remote) {
        await sendDeviceCommand("ring", ringId, { siren: !cs.sirenOn });
      } else {
        await toggleCameraSiren(ringId, !cs.sirenOn);
      }
    } catch { /* ignore */ }
  }, [remote, ringId, cs.sirenOn]);

  return (
    <Card className={styles.card}>
      <div className={styles.header}>
        <Video24Regular />
        <Text className={styles.name} truncate wrap={false}>{device.name}</Text>
        <Badge appearance="filled" color={cs.online ? "success" : "danger"}>
          {cs.online ? "Online" : "Offline"}
        </Badge>
      </div>
      {snapshotSrc && !imgError && (
        <img
          src={snapshotSrc}
          alt={`${device.name} snapshot`}
          className={styles.snapshot}
          onError={() => setImgError(true)}
        />
      )}
      <div className={styles.controls}>
        {cs.hasLight && (
          <Button
            size="small"
            appearance={cs.lightOn ? "primary" : "outline"}
            icon={<Flashlight24Regular />}
            onClick={onToggleLight}
          >
            Light
          </Button>
        )}
        {cs.hasSiren && (
          <Button
            size="small"
            appearance={cs.sirenOn ? "primary" : "outline"}
            icon={<Alert24Regular />}
            onClick={onToggleSiren}
          >
            Siren
          </Button>
        )}
      </div>
    </Card>
  );
}
