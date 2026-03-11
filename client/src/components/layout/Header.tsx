import {
  makeStyles,
  tokens,
  Button,
  Badge,
  Tooltip,
} from "@fluentui/react-components";
import {
  WeatherMoon24Regular,
  WeatherSunny24Regular,
  Navigation24Regular,
  ChatMultiple24Regular,
} from "@fluentui/react-icons";
import { useTheme } from "../../contexts/ThemeContext";
import { useDevices } from "../../hooks/useDevices";

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "center",
    height: "48px",
    paddingLeft: "16px",
    paddingRight: "16px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
    gap: "12px",
    flexShrink: 0,
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

interface HeaderProps {
  onToggleNav?: () => void;
  onToggleChat?: () => void;
  showNavButton?: boolean;
  showChatButton?: boolean;
}

export function Header({ onToggleNav, onToggleChat, showNavButton, showChatButton }: HeaderProps) {
  const styles = useStyles();
  const { mode, toggle } = useTheme();
  const { connectionStatus } = useDevices();

  const statusClass = connectionStatus === "connected"
    ? styles.connected
    : connectionStatus === "connecting"
    ? styles.connecting
    : styles.disconnected;

  return (
    <header className={styles.header}>
      {showNavButton && (
        <Button icon={<Navigation24Regular />} appearance="subtle" onClick={onToggleNav} aria-label="Toggle navigation" />
      )}
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
      />
      {showChatButton && (
        <Button icon={<ChatMultiple24Regular />} appearance="subtle" onClick={onToggleChat} aria-label="Toggle chat" />
      )}
    </header>
  );
}
