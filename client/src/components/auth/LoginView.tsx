import { useState, useCallback, useEffect } from "react";
import {
  makeStyles,
  tokens,
  Card,
  Input,
  Button,
  Text,
  Spinner,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import { useAuth } from "../../contexts/AuthContext";
import { login, getControllers, getAuthStatus, googleAuthUrl } from "../../api/auth";

const USERNAME_STORAGE_KEY = "webcontrol4:login:username";

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
    width: "360px",
    maxWidth: "90vw",
  },
  title: {
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightSemibold,
    textAlign: "center",
    marginBottom: "24px",
    color: tokens.colorBrandForeground1,
  },
  field: { marginBottom: "16px" },
  label: {
    display: "block",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginBottom: "4px",
  },
  error: { marginBottom: "12px" },
  divider: {
    textAlign: "center",
    margin: "16px 0",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

export function LoginView() {
  const styles = useStyles();
  const { state: auth, dispatch } = useAuth();
  const [username, setUsername] = useState(() =>
    typeof window === "undefined" ? "" : (window.localStorage.getItem(USERNAME_STORAGE_KEY) || "")
  );
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [hasGoogle, setHasGoogle] = useState(false);

  useEffect(() => {
    if (username) {
      window.localStorage.setItem(USERNAME_STORAGE_KEY, username);
    } else {
      window.localStorage.removeItem(USERNAME_STORAGE_KEY);
    }
  }, [username]);

  // Check if Google auth is available and check initial auth status
  useEffect(() => {
    // Clean up any previously stored password (security fix)
    try { window.localStorage.removeItem("webcontrol4:login:password"); } catch {}

    (async () => {
      try {
        const status = await getAuthStatus();
        if (status.authenticated && status.user) {
          dispatch({ type: "SET_GOOGLE_AUTH", payload: { email: status.user.email } });
          dispatch({ type: "SET_STAGE", payload: "login" });
          setHasGoogle(true);
        } else {
          dispatch({ type: "SET_STAGE", payload: "login" });
        }
      } catch {
        dispatch({ type: "SET_STAGE", payload: "login" });
      }
    })();
  }, [dispatch]);

  const handleLogin = useCallback(async () => {
    if (!username || !password) return;
    setLoading(true);
    dispatch({ type: "SET_ERROR", payload: null });
    try {
      const result = await login(username, password);
      dispatch({ type: "SET_ACCOUNT_TOKEN", payload: result.accountToken });
      const controllers = await getControllers(result.accountToken);
      dispatch({ type: "SET_CONTROLLERS", payload: controllers.controllers });
    } catch (err) {
      dispatch({ type: "SET_ERROR", payload: err instanceof Error ? err.message : "Login failed" });
    }
    setLoading(false);
  }, [username, password, dispatch]);

  if (auth.stage === "checking") {
    return (
      <div className={styles.root}>
        <Spinner label="Checking authentication..." />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <Card className={styles.card}>
        <Text className={styles.title}>WebControl4</Text>
        {auth.error && (
          <MessageBar intent="error" className={styles.error}>
            <MessageBarBody>{auth.error}</MessageBarBody>
          </MessageBar>
        )}
        <div className={styles.field}>
          <label className={styles.label}>Control4 Username</label>
          <Input
            value={username}
            onChange={(_, d) => setUsername(d.value)}
            placeholder="user@example.com"
            autoComplete="username"
            style={{ width: "100%" }}
            onKeyDown={(e) => { if (e.key === "Enter") handleLogin(); }}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Password</label>
          <Input
            type="password"
            value={password}
            onChange={(_, d) => setPassword(d.value)}
            placeholder="Password"
            autoComplete="current-password"
            style={{ width: "100%" }}
            onKeyDown={(e) => { if (e.key === "Enter") handleLogin(); }}
          />
        </div>
        <Button
          appearance="primary"
          onClick={handleLogin}
          disabled={loading || !username || !password}
          style={{ width: "100%" }}
        >
          {loading ? "Signing in..." : "Sign In"}
        </Button>
        {hasGoogle && (
          <>
            <div className={styles.divider}>or</div>
            <Button
              appearance="outline"
              onClick={() => { window.location.href = googleAuthUrl(); }}
              style={{ width: "100%" }}
            >
              Sign in with Google
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}
