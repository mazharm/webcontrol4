import { useState, useEffect, useCallback } from "react";
import {
  makeStyles,
  tokens,
  Text,
  Card,
  Input,
  Button,
  Dropdown,
  Option,
  Badge,
  Spinner,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import { useAuth } from "../../contexts/AuthContext";
import { useTheme } from "../../contexts/ThemeContext";
import { getSettings, saveSettings } from "../../api/settings";
import { getModels } from "../../api/llm";
import { getRingStatus, ringLogin, ringVerify } from "../../api/ring";
import type { SettingsResponse, RingStatusResponse } from "../../types/api";

const useStyles = makeStyles({
  root: { maxWidth: "800px" },
  title: {
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightSemibold,
    marginBottom: "16px",
  },
  section: { marginBottom: "16px" },
  card: { padding: "16px", marginBottom: "12px" },
  cardTitle: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase400,
    marginBottom: "12px",
  },
  field: {
    marginBottom: "12px",
  },
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

export function SettingsView() {
  const styles = useStyles();
  const { state: auth } = useAuth();
  const { mode, toggle } = useTheme();
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [ringStatus, setRingStatus] = useState<RingStatusResponse | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [ringEmail, setRingEmail] = useState("");
  const [ringPassword, setRingPassword] = useState("");
  const [ringRefreshToken, setRingRefreshToken] = useState("");
  const [ringCode, setRingCode] = useState("");
  const [ringNeeds2FA, setRingNeeds2FA] = useState(false);
  const [ringPrompt, setRingPrompt] = useState<string | null>(null);
  const [ringBusy, setRingBusy] = useState(false);
  const [ringError, setRingError] = useState<string | null>(null);

  const refreshRingStatus = useCallback(async () => {
    const status = await getRingStatus();
    setRingStatus(status);
    return status;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [s, m, r] = await Promise.all([
          getSettings(),
          getModels().catch(() => []),
          refreshRingStatus().catch(() => null),
        ]);
        setSettings(s);
        setSelectedModel(s.anthropicModel || "");
        setModels(m);
        setRingStatus(r);
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, [refreshRingStatus]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {};
      if (apiKey) payload.anthropicKey = apiKey;
      if (selectedModel) payload.anthropicModel = selectedModel;
      const result = await saveSettings(payload as { anthropicKey?: string; anthropicModel?: string });
      setSettings(result);
      setApiKey("");
    } catch { /* ignore */ }
    setSaving(false);
  }, [apiKey, selectedModel]);

  const handleRingLogin = useCallback(async () => {
    setRingBusy(true);
    setRingError(null);
    try {
      const result = await ringLogin({
        email: ringEmail || undefined,
        password: ringPassword || undefined,
        refreshToken: ringRefreshToken || undefined,
      });
      if (result.requires2FA) {
        setRingNeeds2FA(true);
        setRingPrompt(result.prompt || "Enter your Ring verification code.");
      } else {
        setRingNeeds2FA(false);
        setRingPrompt(null);
        setRingCode("");
        await refreshRingStatus();
      }
    } catch (err) {
      setRingError(err instanceof Error ? err.message : "Ring login failed");
    }
    setRingBusy(false);
  }, [refreshRingStatus, ringEmail, ringPassword, ringRefreshToken]);

  const handleRingVerify = useCallback(async () => {
    setRingBusy(true);
    setRingError(null);
    try {
      const result = await ringVerify(ringCode);
      if (result.requires2FA) {
        setRingNeeds2FA(true);
        setRingPrompt(result.prompt || "Verification code required.");
      } else {
        setRingNeeds2FA(false);
        setRingPrompt(null);
        setRingCode("");
        await refreshRingStatus();
      }
    } catch (err) {
      setRingError(err instanceof Error ? err.message : "Ring verification failed");
    }
    setRingBusy(false);
  }, [refreshRingStatus, ringCode]);

  if (loading) return <Spinner label="Loading settings..." />;

  return (
    <div className={styles.root}>
      <Text className={styles.title}>Settings</Text>

      {/* Connection */}
      <Card className={styles.card}>
        <div className={styles.cardTitle}>Connection</div>
        <div className={styles.status}>
          <span>Controller:</span>
          <Badge appearance="filled" color={auth.controllerIp ? "success" : "warning"}>
            {auth.controllerIp || "Not connected"}
          </Badge>
        </div>
        {auth.controllerIp && (
          <div className={styles.status}>
            <span>IP:</span>
            <Text>{auth.controllerIp}</Text>
          </div>
        )}
      </Card>

      {/* AI Assistant */}
      <Card className={styles.card}>
        <div className={styles.cardTitle}>AI Assistant</div>
        <div className={styles.field}>
          <label className={styles.label}>Anthropic API Key</label>
          <div className={styles.row}>
            <Input
              type="password"
              value={apiKey}
              onChange={(_, d) => setApiKey(d.value)}
              placeholder={settings?.hasAnthropicKey ? "Key is set (enter to change)" : "Enter API key"}
              style={{ flex: 1 }}
            />
            {settings?.hasAnthropicKey && (
              <Badge appearance="filled" color="success">Set</Badge>
            )}
          </div>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Model</label>
          <Dropdown
            value={selectedModel || "Select model"}
            selectedOptions={selectedModel ? [selectedModel] : []}
            onOptionSelect={(_, d) => d.optionValue && setSelectedModel(d.optionValue)}
            style={{ width: "100%" }}
          >
            {models.map((m) => <Option key={m} value={m}>{m}</Option>)}
          </Dropdown>
        </div>
        <Button appearance="primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </Card>

      {/* Ring */}
      <Card className={styles.card}>
        <div className={styles.cardTitle}>Ring Integration</div>
        <div className={styles.status}>
          <span>Status:</span>
          <Badge appearance="filled" color={ringStatus?.connected ? "success" : "warning"}>
            {ringStatus?.connected ? `Connected (${ringStatus.locationCount} location${ringStatus.locationCount === 1 ? "" : "s"})` : "Not connected"}
          </Badge>
        </div>
        {ringStatus?.locations?.length ? (
          <Text className={styles.help}>
            Locations: {ringStatus.locations.map((location) => location.name).join(", ")}
          </Text>
        ) : null}
        {!ringStatus?.connected && (
          <div className={styles.column}>
            {ringError && (
              <MessageBar intent="error">
                <MessageBarBody>{ringError}</MessageBarBody>
              </MessageBar>
            )}
            <div className={styles.field}>
              <label className={styles.label}>Ring Email</label>
              <Input
                value={ringEmail}
                onChange={(_, d) => setRingEmail(d.value)}
                placeholder="name@example.com"
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Ring Password</label>
              <Input
                type="password"
                value={ringPassword}
                onChange={(_, d) => setRingPassword(d.value)}
                placeholder="Password"
              />
            </div>
            <Text className={styles.help}>Or paste a Ring refresh token if you already have one.</Text>
            <div className={styles.field}>
              <label className={styles.label}>Refresh Token</label>
              <Input
                value={ringRefreshToken}
                onChange={(_, d) => setRingRefreshToken(d.value)}
                placeholder="Optional refresh token"
              />
            </div>
            <Button
              appearance="primary"
              onClick={handleRingLogin}
              disabled={ringBusy || ((!ringEmail || !ringPassword) && !ringRefreshToken)}
            >
              {ringBusy ? "Connecting..." : "Connect Ring"}
            </Button>
            {ringNeeds2FA && (
              <>
                <Text className={styles.help}>{ringPrompt || "Enter your verification code."}</Text>
                <div className={styles.field}>
                  <label className={styles.label}>Verification Code</label>
                  <Input
                    value={ringCode}
                    onChange={(_, d) => setRingCode(d.value)}
                    placeholder="123456"
                  />
                </div>
                <Button appearance="outline" onClick={handleRingVerify} disabled={ringBusy || !ringCode}>
                  Verify Code
                </Button>
              </>
            )}
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
