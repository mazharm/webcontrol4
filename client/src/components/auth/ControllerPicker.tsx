import { useState, useCallback, useEffect } from "react";
import {
  makeStyles,
  tokens,
  Card,
  Text,
  Button,
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
});

function normalize(s: string): string {
  return s.replace(/[_\-"]/g, "").toLowerCase();
}

function isIpv4Address(value: string | undefined): value is string {
  return !!value && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

function isMockController(ctrl: Controller & { localIP?: string }) {
  return ctrl.commonName === "mock-controller" || ctrl.address === "mock" || ctrl.localIP === "mock";
}

const MOCK_CONTROLLER: Controller & { localIP?: string } = {
  commonName: "mock-controller",
  name: "Mock Controller",
  address: "mock",
  localIP: "mock",
};

export function ControllerPicker() {
  const styles = useStyles();
  const { state: auth, dispatch } = useAuth();
  const [controllers, setControllers] = useState<(Controller & { localIP?: string })[]>([]);
  const [selectedCN, setSelectedCN] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [discovering, setDiscovering] = useState(true);

  const selectController = useCallback(async (ctrl: Controller & { localIP?: string }) => {
    setLoading(true);
    dispatch({ type: "SET_ERROR", payload: null });
    try {
      if (!auth.accountToken) throw new Error("Missing account token");

      const result = await getDirectorToken(auth.accountToken!, ctrl.commonName);
      const token = result.directorToken;
      let ip = isMockController(ctrl)
        ? "mock"
        : (ctrl.localIP || (isIpv4Address(ctrl.address) ? ctrl.address : ""));
      if (!ip) {
        const entered = window.prompt(
          `Controller "${ctrl.name || ctrl.commonName}" was not auto-discovered. Enter its local IP address:`,
          "",
        );
        if (!entered) return;
        const trimmed = entered.trim();
        if (!isIpv4Address(trimmed)) {
          throw new Error("Please enter a valid IPv4 address");
        }
        ip = trimmed;
      }

      await connectRealtime({
        ip,
        token,
        accountToken: auth.accountToken,
        controllerCommonName: ctrl.commonName,
      });
      dispatch({ type: "SET_DIRECTOR", payload: { ip, token } });
    } catch (err) {
      dispatch({ type: "SET_ERROR", payload: err instanceof Error ? err.message : "Connection failed" });
    } finally {
      setLoading(false);
    }
  }, [auth.accountToken, dispatch]);

  // Run SDDP discovery and match IPs to controllers, then auto-connect if single.
  // If nothing usable is discovered, fall back to the mock controller instead of
  // prompting for manual connection details.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const ctrls = auth.controllers.map((c) => ({ ...c, localIP: c.address || undefined }));
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

      const finalControllers = ctrls.length > 0 ? ctrls : [MOCK_CONTROLLER];

      if (cancelled) return;
      setControllers(finalControllers);
      setDiscovering(false);
      setSelectedCN(finalControllers.length > 1 ? finalControllers[0].commonName : "");

      if (finalControllers.length === 1) {
        void selectController(finalControllers[0]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [auth.controllers, selectController]);

  const handleConnect = useCallback(() => {
    const ctrl = controllers.find((c) => c.commonName === selectedCN);
    if (ctrl) selectController(ctrl);
  }, [selectedCN, controllers, selectController]);

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
