import { useNavigate, useLocation } from "react-router-dom";
import { makeStyles, tokens } from "@fluentui/react-components";
import {
  ChartMultiple24Regular,
  Flash24Regular,
  Settings24Regular,
} from "@fluentui/react-icons";

const useStyles = makeStyles({
  root: {
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    padding: "8px",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "10px 8px",
    cursor: "pointer",
    fontSize: tokens.fontSizeBase300,
    borderRadius: tokens.borderRadiusMedium,
    minHeight: "44px",
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground3,
    },
  },
  active: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
});

interface NavFooterProps {
  onNavigate: () => void;
}

export function NavFooter({ onNavigate }: NavFooterProps) {
  const styles = useStyles();
  const navigate = useNavigate();
  const location = useLocation();

  const items = [
    { path: "/history", label: "History", icon: <ChartMultiple24Regular /> },
    { path: "/routines", label: "Routines", icon: <Flash24Regular /> },
    { path: "/settings", label: "Settings", icon: <Settings24Regular /> },
  ];

  return (
    <div className={styles.root}>
      {items.map((item) => (
        <div
          key={item.path}
          className={`${styles.item} ${location.pathname === item.path ? styles.active : ""}`}
          onClick={() => { navigate(item.path); onNavigate(); }}
        >
          {item.icon}
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}
