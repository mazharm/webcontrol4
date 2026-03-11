import { useState, useCallback, useEffect } from "react";
import {
  makeStyles,
  tokens,
  Card,
  Text,
  Button,
  Input,
  Spinner,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import { useAuth } from "../../contexts/AuthContext";
import { getDirectorToken, discoverControllers } from "../../api/auth";
import { connectRealtime } from "../../api/director";
import type { Controller } from "../../types/devices";

const useStyles = makeStyles({
  root: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    backgroundColor: tokens.colorNeutralBackground1,
  },
  card: {
    padding: "32px",
    width: "400px",
    maxWidth: "90vw",
  },
  title: {
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightSemibold,
    textAlign: "center",
    marginBottom: "24px",
    color: tokens.colorBrandForeground1,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    marginBottom: "16px",
  },
  item: {
    padding: "12px",
    cursor: "pointer",
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground3,
    },
  },
  selected: {
    borderColor: tokens.colorBrandStroke1 as unknown as string,
    backgroundColor: tokens.colorBrandBackground2,
  } as Record<string, string>,
  name: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase400,
  },
  address: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  error: { marginBottom: "12px" },
  discovering: {
    textAlign: "center",
    padding: "16px",
    color: tokens.colorNeutralForeground3,
  },
  divider: {
    textAlign: "center",
    margin: "16px 0",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  directRow: {
    display: "flex",
    gap: "8px",
    marginBottom: "8px",
  },
});

function normalize(s: string): string {
  return s.replace(/[_\-"]/g, "").toLowerCase();
}

export function ControllerPicker() {
  const styles = useStyles();
  const { state: auth, dispatch } = useAuth();
  const [controllers, setControllers] = useState<(Controller & { localIP?: string })[]>(
    auth.controllers.map((c) => ({ ...c, localIP: c.address || undefined }))
  );
  const [selectedCN, setSelectedCN] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [discovering, setDiscovering] = useState(true);
  const [directIp, setDirectIp] = useState("");
  const [directToken, setDirectToken] = useState("");

  // Run SDDP discovery and match IPs to controllers, then auto-connect if single
  useEffect(() => {
    (async () => {
      const ctrls = auth.controllers.map((c) => ({ ...c, localIP: c.address || undefined }));

      try {
        const devices = await discoverControllers();
        if (devices.length > 0) {
          for (const c of ctrls) {
            const cn = normalize(c.commonName || "");
            const match = devices.find((d) => {
              const host = normalize(d.host || "");
              return host && cn && (cn.includes(host) || host.includes(cn));
            });
            if (match) c.localIP = match.ip;
          }
        }
      } catch {
        // discovery failed, non-fatal
      }

      setControllers(ctrls);
      setDiscovering(false);

      // Auto-connect if single controller
      if (ctrls.length === 1) {
        selectController(ctrls[0]);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectController = useCallback(async (ctrl: Controller & { localIP?: string }) => {
    setLoading(true);
    dispatch({ type: "SET_ERROR", payload: null });
    try {
      const result = await getDirectorToken(auth.accountToken!, ctrl.commonName);
      const token = result.directorToken;

      // Determine IP: use discovered localIP, or "mock" for demo, or prompt
      let ip = ctrl.localIP || "";

      // Demo/mock mode: mock-controller gets IP "mock"
      if (ctrl.commonName === "mock-controller" || ctrl.address === "mock") {
        ip = "mock";
      }

      if (!ip) {
        // No IP discovered — prompt user
        const entered = window.prompt(
          "Controller not found on network. Enter its local IP address:"
        );
        if (!entered) {
          setLoading(false);
          return;
        }
        const trimmed = entered.trim();
        if (trimmed !== "mock" && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed)) {
          dispatch({ type: "SET_ERROR", payload: "Please enter a valid IPv4 address." });
          setLoading(false);
          return;
        }
        ip = trimmed;
      }

      dispatch({ type: "SET_DIRECTOR", payload: { ip, token } });

      // Initialize realtime connection
      try {
        await connectRealtime({ ip, token });
      } catch {
        // non-fatal
      }
    } catch (err) {
      dispatch({ type: "SET_ERROR", payload: err instanceof Error ? err.message : "Connection failed" });
      setLoading(false);
    }
  }, [auth.accountToken, dispatch]);

  const handleConnect = useCallback(() => {
    const ctrl = controllers.find((c) => c.commonName === selectedCN);
    if (ctrl) selectController(ctrl);
  }, [selectedCN, controllers, selectController]);

  const handleDirectConnect = useCallback(async () => {
    const ip = directIp.trim();
    const token = directToken.trim();
    if (!ip || !token) return;
    if (ip !== "mock" && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
      dispatch({ type: "SET_ERROR", payload: "Please enter a valid IPv4 address." });
      return;
    }
    setLoading(true);
    dispatch({ type: "SET_DIRECTOR", payload: { ip, token } });
    try {
      await connectRealtime({ ip, token });
    } catch {
      // non-fatal
    }
  }, [directIp, directToken, dispatch]);

  return (
    <div className={styles.root}>
      <Card className={styles.card}>
        <Text className={styles.title}>Select Controller</Text>
        {auth.error && (
          <MessageBar intent="error" className={styles.error}>
            <MessageBarBody>{auth.error}</MessageBarBody>
          </MessageBar>
        )}
        {discovering ? (
          <div className={styles.discovering}>
            <Spinner size="small" label="Discovering controllers on network..." />
          </div>
        ) : controllers.length > 1 ? (
          <>
            <div className={styles.list}>
              {controllers.map((ctrl) => (
                <div
                  key={ctrl.commonName}
                  className={`${styles.item} ${selectedCN === ctrl.commonName ? styles.selected : ""}`}
                  onClick={() => setSelectedCN(ctrl.commonName)}
                >
                  <div className={styles.name}>{ctrl.name || ctrl.commonName}</div>
                  <div className={styles.address}>{ctrl.localIP || "IP not found"}</div>
                </div>
              ))}
            </div>
            <Button
              appearance="primary"
              onClick={handleConnect}
              disabled={loading || !selectedCN}
              style={{ width: "100%" }}
            >
              {loading ? <Spinner size="tiny" /> : "Connect"}
            </Button>
          </>
        ) : (
          <div className={styles.discovering}>
            <Spinner size="small" label="Connecting..." />
          </div>
        )}

        <div className={styles.divider}>or connect directly</div>
        <div className={styles.directRow}>
          <Input
            placeholder="IP or 'mock'"
            value={directIp}
            onChange={(_, d) => setDirectIp(d.value)}
            style={{ flex: 1 }}
          />
          <Input
            placeholder="Bearer token"
            value={directToken}
            onChange={(_, d) => setDirectToken(d.value)}
            style={{ flex: 1 }}
          />
        </div>
        <Button
          appearance="outline"
          onClick={handleDirectConnect}
          disabled={loading || !directIp.trim() || !directToken.trim()}
          style={{ width: "100%" }}
        >
          Direct Connect
        </Button>

        <Button
          appearance="subtle"
          onClick={() => dispatch({ type: "LOGOUT" })}
          style={{ width: "100%", marginTop: "8px" }}
        >
          Back to Login
        </Button>
      </Card>
    </div>
  );
}
