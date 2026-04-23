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

function isIpv4Address(value: string | undefined): value is string {
  return !!value && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

function isPrivateIpv4Address(value: string | undefined): value is string {
  if (!isIpv4Address(value)) return false;
  const [a, b] = value.split(".").map((part) => Number(part));
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function normalizeControllerId(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.local$/g, "")
    .replace(/^control4[_-]?/g, "")
    .replace(/[^a-z0-9]/g, "");
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
        : (isPrivateIpv4Address(ctrl.localIP) ? ctrl.localIP : "");
      if (!ip) {
        throw new Error(`Controller "${ctrl.name || ctrl.commonName}" was discovered without a usable local IP`);
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
  // If no controllers were discovered on the network and none have a usable IP,
  // fall back to the mock controller (matching legacy behavior).
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const ctrls = auth.controllers.map((c) => ({
        ...c,
        localIP: isPrivateIpv4Address(c.address) ? c.address : undefined,
      }));
      const devices = await discoverControllers();

      if (devices.length > 0) {
        for (const c of ctrls) {
          const controllerIds = [
            normalizeControllerId(c.commonName || ""),
            normalizeControllerId(c.name || ""),
          ].filter(Boolean);

          let match = devices.find((d) => {
            const host = normalizeControllerId(d.host || "");
            return !!host && controllerIds.some((controllerId) =>
              controllerId === host || controllerId.includes(host) || host.includes(controllerId)
            );
          });

          if (!match && ctrls.length === 1 && devices.length === 1) {
            match = devices[0];
          }

          if (match && isPrivateIpv4Address(match.ip)) {
            c.localIP = match.ip;
          }
        }
      }

      const finalControllers = ctrls.filter((c) => isPrivateIpv4Address(c.localIP));
      const usableControllers = finalControllers.length > 0 ? finalControllers : [MOCK_CONTROLLER];

      if (cancelled) return;
      setControllers(usableControllers);
      setDiscovering(false);
      setSelectedCN(usableControllers[0]?.commonName || "");

      if (usableControllers.length === 1) {
        void selectController(usableControllers[0]);
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

  const showControllerList = !discovering && (
    controllers.length > 1 || (controllers.length === 1 && (!loading || !!auth.error))
  );

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
        ) : showControllerList ? (
          <>
            <div className={styles.list}>
              {controllers.map((ctrl) => (
                <div
                  key={ctrl.commonName}
                  className={`${styles.item} ${selectedCN === ctrl.commonName ? styles.selected : ""}`}
                  onClick={() => setSelectedCN(ctrl.commonName)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedCN(ctrl.commonName); } }}
                  role="button"
                  tabIndex={0}
                  aria-label={`Select controller ${ctrl.name || ctrl.commonName}`}
                  aria-pressed={selectedCN === ctrl.commonName}
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
