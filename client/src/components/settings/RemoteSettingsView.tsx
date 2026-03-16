import { useState, useCallback, useEffect } from "react";
import {
  makeStyles,
  tokens,
  Text,
  Card,
  Input,
  Button,
  Badge,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import { useTheme } from "../../contexts/ThemeContext";
import {
  getMqttConfig,
  saveMqttConfig,
  clearMqttConfig,
} from "../../config/transport";
import {
  getConnectionState,
  onConnectionChange,
  type MqttConnectionState,
} from "../../services/mqtt-client";
import { useBridgeStatus } from "../../hooks/useBridgeStatus";

const useStyles = makeStyles({
  root: { maxWidth: "800px" },
  title: {
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightSemibold,
    marginBottom: "16px",
  },
  card: { padding: "16px", marginBottom: "12px" },
  cardTitle: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase400,
    marginBottom: "12px",
  },
  field: { marginBottom: "12px" },
  label: {
    display: "block",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginBottom: "4px",
  },
  row: {
    display: "flex",
    gap: "8px",
    alignItems: "center",
  },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  status: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "8px",
  },
  help: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

export function RemoteSettingsView() {
  const styles = useStyles();
  const { mode, toggle } = useTheme();
  const bridge = useBridgeStatus();

  const [mqttState, setMqttState] = useState<MqttConnectionState>(getConnectionState);
  const [editing, setEditing] = useState(false);
  const [brokerWsUrl, setBrokerWsUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [homeId, setHomeId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const config = getMqttConfig();

  useEffect(() => {
    return onConnectionChange(setMqttState);
  }, []);

  const connectionColor = mqttState === "connected" ? "success" : mqttState === "reconnecting" ? "warning" : "danger";
  const connectionLabel = mqttState === "connected" ? "Connected" : mqttState === "reconnecting" ? "Reconnecting..." : "Disconnected";

  const bridgeColor = bridge.online ? "success" : "danger";
  const bridgeLabel = bridge.online
    ? `Online (uptime ${formatUptime(bridge.uptime)})`
    : "Offline";

  const handleStartEdit = useCallback(() => {
    setBrokerWsUrl(config.brokerWsUrl);
    setUsername(config.username);
    setPassword("");
    setHomeId(config.homeId);
    setEditing(true);
    setError(null);
  }, [config]);

  const handleSave = useCallback(() => {
    if (!brokerWsUrl || !username) {
      setError("Broker URL and username are required.");
      return;
    }
    saveMqttConfig({
      brokerWsUrl,
      username,
      password: password || config.password,
      homeId: homeId || "home1",
    });
    window.location.reload();
  }, [brokerWsUrl, username, password, homeId, config.password]);

  const handleDisconnect = useCallback(() => {
    clearMqttConfig();
    window.location.reload();
  }, []);

  return (
    <div className={styles.root}>
      <Text className={styles.title}>Settings</Text>

      {/* MQTT Connection */}
      <Card className={styles.card}>
        <div className={styles.cardTitle}>MQTT Connection</div>
        <div className={styles.status}>
          <span>Broker:</span>
          <Badge appearance="filled" color={connectionColor}>{connectionLabel}</Badge>
        </div>
        <div className={styles.status}>
          <span>Home Bridge:</span>
          <Badge appearance="filled" color={bridgeColor}>{bridgeLabel}</Badge>
        </div>
        {!editing && (
          <>
            <Text className={styles.help}>Broker: {config.brokerWsUrl}</Text>
            <Text className={styles.help}>Username: {config.username}</Text>
            <Text className={styles.help}>Home ID: {config.homeId}</Text>
            <div className={styles.row} style={{ marginTop: "12px" }}>
              <Button appearance="outline" onClick={handleStartEdit}>
                Edit
              </Button>
              <Button appearance="outline" onClick={handleDisconnect}>
                Disconnect
              </Button>
            </div>
          </>
        )}
        {editing && (
          <div className={styles.column} style={{ marginTop: "8px" }}>
            {error && (
              <MessageBar intent="error">
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
            <div className={styles.field}>
              <label className={styles.label}>Broker WebSocket URL</label>
              <Input
                value={brokerWsUrl}
                onChange={(_, d) => setBrokerWsUrl(d.value)}
                placeholder="wss://xxx.hivemq.cloud:8884/mqtt"
                style={{ width: "100%" }}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Username</label>
              <Input
                value={username}
                onChange={(_, d) => setUsername(d.value)}
                style={{ width: "100%" }}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Password</label>
              <Input
                type="password"
                value={password}
                onChange={(_, d) => setPassword(d.value)}
                placeholder="Leave blank to keep current"
                style={{ width: "100%" }}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Home ID</label>
              <Input
                value={homeId}
                onChange={(_, d) => setHomeId(d.value)}
                placeholder="home1"
                style={{ width: "100%" }}
              />
            </div>
            <div className={styles.row}>
              <Button appearance="primary" onClick={handleSave}>
                Save & Reconnect
              </Button>
              <Button appearance="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Theme */}
      <Card className={styles.card}>
        <div className={styles.cardTitle}>Theme</div>
        <div className={styles.row}>
          <Button appearance={mode === "light" ? "primary" : "outline"} onClick={() => { if (mode !== "light") toggle(); }}>
            Light
          </Button>
          <Button appearance={mode === "dark" ? "primary" : "outline"} onClick={() => { if (mode !== "dark") toggle(); }}>
            Dark
          </Button>
        </div>
      </Card>
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
