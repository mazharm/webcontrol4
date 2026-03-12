import { makeStyles, tokens, Button, Badge, Tooltip } from "@fluentui/react-components";
import { WeatherMoon24Regular, WeatherSunny24Regular } from "@fluentui/react-icons";
import { useTheme } from "../../contexts/ThemeContext";
import { useDevices } from "../../hooks/useDevices";

const useStyles = makeStyles({
  root: {
    display: "flex",
    alignItems: "center",
    height: "48px",
    paddingLeft: "16px",
    paddingRight: "12px",
    gap: "8px",
    flexShrink: 0,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  logo: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase400,
    color: tokens.colorBrandForeground1,
    whiteSpace: "nowrap",
  },
  spacer: { flex: 1 },
  statusDot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    display: "inline-block",
  },
  connected: { backgroundColor: "#22c55e" },
  connecting: { backgroundColor: "#eab308" },
  disconnected: { backgroundColor: "#ef4444" },
});

export function MobileHeader() {
  const styles = useStyles();
  const { mode, toggle } = useTheme();
  const { connectionStatus } = useDevices();

  const statusClass = connectionStatus === "connected"
    ? styles.connected
    : connectionStatus === "connecting"
    ? styles.connecting
    : styles.disconnected;

  return (
    <div className={styles.root}>
      <span className={styles.logo}>WebControl4</span>
      <Tooltip content={connectionStatus} relationship="label">
        <Badge
          size="tiny"
          icon={<span className={`${styles.statusDot} ${statusClass}`} />}
          appearance="ghost"
        />
      </Tooltip>
      <span className={styles.spacer} />
      <Button
        icon={mode === "dark" ? <WeatherSunny24Regular /> : <WeatherMoon24Regular />}
        appearance="subtle"
        onClick={toggle}
        aria-label="Toggle theme"
        size="small"
      />
    </div>
  );
}
