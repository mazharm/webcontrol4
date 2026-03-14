// ---------------------------------------------------------------------------
// contexts/TransportProvider.tsx – Transport abstraction layer
// ---------------------------------------------------------------------------
// In local mode: renders children directly (existing REST/SSE flow)
// In mqtt mode: wraps children in MqttProvider
// ---------------------------------------------------------------------------

import { createContext, useContext, useState, useCallback } from "react";
import { transportMode, type TransportMode, hasMqttConfig } from "../config/transport";
import { MqttProvider } from "./MqttProvider";

const TransportContext = createContext<TransportMode>("local");

export function useTransportMode(): TransportMode {
  return useContext(TransportContext);
}

export function TransportProvider({ children }: { children: React.ReactNode }) {
  const [mqttReady, setMqttReady] = useState(() => transportMode !== "mqtt" || hasMqttConfig());
  const onConfigured = useCallback(() => setMqttReady(true), []);

  return (
    <TransportContext.Provider value={transportMode}>
      {transportMode === "mqtt" ? (
        mqttReady ? (
          <MqttProvider>{children}</MqttProvider>
        ) : (
          <MqttSetupGate onConfigured={onConfigured} />
        )
      ) : (
        children
      )}
    </TransportContext.Provider>
  );
}

// -- Inline setup form for remote mode when no MQTT config exists --

import {
  Card,
  Input,
  Button,
  Text,
  makeStyles,
  tokens,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import { saveMqttConfig } from "../config/transport";

const useSetupStyles = makeStyles({
  root: {
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
  },
  card: { padding: "24px", maxWidth: "400px", width: "100%" },
  title: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase500,
    marginBottom: "16px",
  },
  field: { marginBottom: "12px" },
  label: {
    display: "block",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginBottom: "4px",
  },
  help: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    marginBottom: "12px",
  },
});

function MqttSetupGate({ onConfigured }: { onConfigured: () => void }) {
  const styles = useSetupStyles();
  const [brokerWsUrl, setBrokerWsUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [homeId, setHomeId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleConnect = useCallback(() => {
    if (!brokerWsUrl || !username || !password) {
      setError("Broker URL, username, and password are required.");
      return;
    }
    saveMqttConfig({
      brokerWsUrl,
      username,
      password,
      homeId: homeId || "home1",
    });
    onConfigured();
  }, [brokerWsUrl, username, password, homeId, onConfigured]);

  return (
    <div className={styles.root}>
      <Card className={styles.card}>
        <Text className={styles.title}>MQTT Connection Setup</Text>
        <Text className={styles.help}>
          Enter your MQTT broker details to connect remotely.
        </Text>
        {error && (
          <MessageBar intent="error" style={{ marginBottom: "12px" }}>
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
            placeholder="MQTT username"
            style={{ width: "100%" }}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Password</label>
          <Input
            type="password"
            value={password}
            onChange={(_, d) => setPassword(d.value)}
            placeholder="MQTT password"
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
        <Button
          appearance="primary"
          onClick={handleConnect}
          disabled={!brokerWsUrl || !username || !password}
          style={{ width: "100%" }}
        >
          Connect
        </Button>
      </Card>
    </div>
  );
}
