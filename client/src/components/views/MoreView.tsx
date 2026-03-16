import { useNavigate } from "react-router-dom";
import { makeStyles, tokens } from "@fluentui/react-components";
import {
  Temperature24Regular,
  ShieldLock24Regular,
  Video24Regular,
  Drop24Regular,
  ChartMultiple24Regular,
  Flash24Regular,
  Settings24Regular,
  ChevronRight20Regular,
} from "@fluentui/react-icons";


const useStyles = makeStyles({
  root: {
    maxWidth: "600px",
  },
  title: {
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
    marginBottom: "16px",
  },
  group: {
    marginBottom: "8px",
  },
  divider: {
    height: "1px",
    backgroundColor: tokens.colorNeutralStroke1,
    margin: "4px 0",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "14px 8px",
    cursor: "pointer",
    borderRadius: tokens.borderRadiusMedium,
    fontSize: tokens.fontSizeBase300,
    minHeight: "44px",
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground3,
    },
  },
  label: { flex: 1 },
  chevron: {
    color: tokens.colorNeutralForeground3,
  },
});

export function MoreView() {
  const styles = useStyles();
  const navigate = useNavigate();

  const deviceViews = [
    { path: "/climate", label: "All Climate", icon: <Temperature24Regular /> },
    { path: "/security", label: "All Security", icon: <ShieldLock24Regular /> },
    { path: "/cameras", label: "All Cameras", icon: <Video24Regular /> },
    { path: "/water-leak", label: "Water Leak", icon: <Drop24Regular /> },
  ];

  const utilityViews = [
    { path: "/history", label: "History", icon: <ChartMultiple24Regular /> },
    { path: "/routines", label: "Routines", icon: <Flash24Regular /> },
    { path: "/settings", label: "Settings", icon: <Settings24Regular /> },
  ];

  const renderItem = (item: { path: string; label: string; icon: JSX.Element }) => (
    <div key={item.path} className={styles.item} onClick={() => navigate(item.path)}>
      {item.icon}
      <span className={styles.label}>{item.label}</span>
      <ChevronRight20Regular className={styles.chevron} />
    </div>
  );

  return (
    <div className={styles.root}>
      <div className={styles.title}>More</div>
      <div className={styles.group}>
        {deviceViews.map(renderItem)}
      </div>
      {utilityViews.length > 0 && (
        <>
          <div className={styles.divider} />
          <div className={styles.group}>
            {utilityViews.map(renderItem)}
          </div>
        </>
      )}
    </div>
  );
}
