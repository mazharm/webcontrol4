import { makeStyles, tokens } from "@fluentui/react-components";
import { QuickViews } from "../nav/QuickViews";
import { FloorTree } from "../nav/FloorTree";
import { NavFooter } from "../nav/NavFooter";

const useStyles = makeStyles({
  root: {
    width: "260px",
    minWidth: "260px",
    display: "flex",
    flexDirection: "column",
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
    height: "100%",
    overflow: "hidden",
  },
  overlay: {
    position: "fixed",
    top: "48px",
    left: 0,
    bottom: 0,
    zIndex: 100,
  },
  scrollable: {
    flex: 1,
    overflowY: "auto",
    overflowX: "hidden",
  },
});

interface NavPanelProps {
  onNavigate: () => void;
  overlay?: boolean;
}

export function NavPanel({ onNavigate, overlay }: NavPanelProps) {
  const styles = useStyles();
  return (
    <nav className={`${styles.root} ${overlay ? styles.overlay : ""}`}>
      <QuickViews onNavigate={onNavigate} />
      <div className={styles.scrollable}>
        <FloorTree onNavigate={onNavigate} />
      </div>
      <NavFooter onNavigate={onNavigate} />
    </nav>
  );
}
