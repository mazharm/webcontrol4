import { makeStyles, tokens, Button, Badge, Tooltip } from "@fluentui/react-components";
import { 
  WeatherMoon24Regular, 
  WeatherSunny24Regular, 
  ChatMultiple24Regular 
} from "@fluentui/react-icons";
import { useTheme } from "../../contexts/ThemeContext";
import { useDevices } from "../../hooks/useDevices";
import { QuickViews } from "../nav/QuickViews";
import { FloorTree } from "../nav/FloorTree";
import { NavFooter } from "../nav/NavFooter";

const useStyles = makeStyles({
  root: {
    width: "260px",
    minWidth: "260px",
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    height: "48px",
    padding: "0 16px",
    gap: "8px",
    flexShrink: 0,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  logo: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase400,
    color: tokens.colorBrandForeground1,
    whiteSpace: "nowrap",
    marginRight: "4px",
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
  overlay: {
    position: "fixed",
    top: "48px",
    left: 0,
    bottom: 0,
    zIndex: 100,
  },
  scrollable: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    overflowX: "hidden",
  },
});

interface NavPanelProps {
  onNavigate: () => void;
  overlay?: boolean;
  showHeader?: boolean;
  onToggleChat?: () => void;
  showChatButton?: boolean;
}

export function NavPanel({ 
  onNavigate, 
  overlay, 
  showHeader, 
  onToggleChat, 
  showChatButton 
}: NavPanelProps) {
  const styles = useStyles();
  const { mode, toggle } = useTheme();
  const { connectionStatus } = useDevices();

  const statusClass = connectionStatus === "connected"
    ? styles.connected
    : connectionStatus === "connecting"
    ? styles.connecting
    : styles.disconnected;

  return (
    <nav className={`${styles.root} ${overlay ? styles.overlay : ""}`}>
      {showHeader && (
        <div className={styles.header}>
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
          {showChatButton && (
            <Button 
              icon={<ChatMultiple24Regular />} 
              appearance="subtle" 
              onClick={onToggleChat} 
              aria-label="Toggle chat"
              size="small"
            />
          )}
        </div>
      )}
      <QuickViews onNavigate={onNavigate} />
      <div className={styles.scrollable}>
        <FloorTree onNavigate={onNavigate} />
      </div>
      <NavFooter onNavigate={onNavigate} />
    </nav>
  );
}
