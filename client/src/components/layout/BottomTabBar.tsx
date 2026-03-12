import { makeStyles, tokens } from "@fluentui/react-components";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Home24Regular, Home24Filled,
  Building24Regular, Building24Filled,
  Lightbulb24Regular, Lightbulb24Filled,
  Chat24Regular, Chat24Filled,
  MoreHorizontal24Regular, MoreHorizontal24Filled,
} from "@fluentui/react-icons";

const useStyles = makeStyles({
  root: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-around",
    height: "56px",
    flexShrink: 0,
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  tab: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "2px",
    flex: 1,
    height: "100%",
    border: "none",
    background: "none",
    cursor: "pointer",
    color: tokens.colorNeutralForeground3,
    fontSize: "10px",
    fontWeight: tokens.fontWeightRegular,
    minWidth: "44px",
    minHeight: "44px",
    WebkitTapHighlightColor: "transparent",
  },
  active: {
    color: tokens.colorBrandForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
});

interface BottomTabBarProps {
  onOpenRooms: () => void;
  onOpenChat: () => void;
}

export function BottomTabBar({ onOpenRooms, onOpenChat }: BottomTabBarProps) {
  const styles = useStyles();
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path: string) => location.pathname === path;

  return (
    <div className={styles.root}>
      <button
        className={`${styles.tab} ${isActive("/") ? styles.active : ""}`}
        onClick={() => navigate("/")}
      >
        {isActive("/") ? <Home24Filled /> : <Home24Regular />}
        <span>Home</span>
      </button>
      <button
        className={styles.tab}
        onClick={onOpenRooms}
      >
        <Building24Regular />
        <span>Rooms</span>
      </button>
      <button
        className={`${styles.tab} ${isActive("/lights") ? styles.active : ""}`}
        onClick={() => navigate("/lights")}
      >
        {isActive("/lights") ? <Lightbulb24Filled /> : <Lightbulb24Regular />}
        <span>Lights</span>
      </button>
      <button
        className={styles.tab}
        onClick={onOpenChat}
      >
        <Chat24Regular />
        <span>Chat</span>
      </button>
      <button
        className={`${styles.tab} ${isActive("/more") ? styles.active : ""}`}
        onClick={() => navigate("/more")}
      >
        {isActive("/more") ? <MoreHorizontal24Filled /> : <MoreHorizontal24Regular />}
        <span>More</span>
      </button>
    </div>
  );
}
