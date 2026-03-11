import { useState, useCallback } from "react";
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

  const onToggleLight = useCallback(async () => {
    try {
      await toggleCameraLight(ringId, !cs.lightOn);
    } catch { /* ignore */ }
  }, [ringId, cs.lightOn]);

  const onToggleSiren = useCallback(async () => {
    try {
      await toggleCameraSiren(ringId, !cs.sirenOn);
    } catch { /* ignore */ }
  }, [ringId, cs.sirenOn]);

  return (
    <Card className={styles.card}>
      <div className={styles.header}>
        <Video24Regular />
        <Text className={styles.name} truncate wrap={false}>{device.name}</Text>
        <Badge appearance="filled" color={cs.online ? "success" : "danger"}>
          {cs.online ? "Online" : "Offline"}
        </Badge>
      </div>
      {cs.snapshotUrl && !imgError && (
        <img
          src={cs.snapshotUrl}
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
