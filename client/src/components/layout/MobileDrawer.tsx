import { useEffect, type ReactNode } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";

const useStyles = makeStyles({
  scrim: {
    position: "fixed",
    inset: 0,
    backgroundColor: "rgba(0,0,0,0.5)",
    zIndex: 200,
  },
  leftPanel: {
    position: "fixed",
    top: 0,
    left: 0,
    bottom: 0,
    width: "85vw",
    maxWidth: "340px",
    zIndex: 201,
    backgroundColor: tokens.colorNeutralBackground2,
    display: "flex",
    flexDirection: "column",
    paddingTop: "env(safe-area-inset-top)",
    paddingBottom: "env(safe-area-inset-bottom)",
    animationName: {
      from: { transform: "translateX(-100%)" },
      to: { transform: "translateX(0)" },
    },
    animationDuration: "200ms",
    animationTimingFunction: "ease-out",
  },
  bottomSheet: {
    position: "fixed",
    left: 0,
    right: 0,
    bottom: 0,
    height: "90dvh",
    zIndex: 201,
    backgroundColor: tokens.colorNeutralBackground2,
    borderTopLeftRadius: "12px",
    borderTopRightRadius: "12px",
    display: "flex",
    flexDirection: "column",
    paddingBottom: "env(safe-area-inset-bottom)",
    animationName: {
      from: { transform: "translateY(100%)" },
      to: { transform: "translateY(0)" },
    },
    animationDuration: "250ms",
    animationTimingFunction: "ease-out",
  },
  dragHandle: {
    width: "36px",
    height: "4px",
    borderRadius: "2px",
    backgroundColor: tokens.colorNeutralStroke1,
    margin: "8px auto",
    flexShrink: 0,
  },
});

interface MobileDrawerProps {
  position: "left" | "bottom";
  onClose: () => void;
  children: ReactNode;
}

export function MobileDrawer({ position, onClose, children }: MobileDrawerProps) {
  const styles = useStyles();

  // Push a dummy history entry so back gesture closes the drawer
  useEffect(() => {
    window.history.pushState({ drawer: true }, "");
    const handlePop = () => {
      onClose();
    };
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, [onClose]);

  const handleScrimClick = () => {
    // Go back to pop the dummy entry instead of just closing
    window.history.back();
  };

  return (
    <>
      <div className={styles.scrim} onClick={handleScrimClick} />
      <div className={position === "left" ? styles.leftPanel : styles.bottomSheet}>
        {position === "bottom" && <div className={styles.dragHandle} />}
        {children}
      </div>
    </>
  );
}
