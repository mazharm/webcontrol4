import { useState, useCallback, useEffect, type ReactNode } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import { Header } from "./Header";
import { NavPanel } from "./NavPanel";
import { ChatPanel } from "../chat/ChatPanel";
import { MobileHeader } from "./MobileHeader";
import { BottomTabBar } from "./BottomTabBar";
import { MobileDrawer } from "./MobileDrawer";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100dvh",
    maxHeight: "100dvh",
    overflow: "hidden",
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
  },
  body: {
    display: "flex",
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  content: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflowY: "auto",
    overflowX: "hidden",
    padding: "16px",
  },
  overlay: {
    position: "fixed",
    inset: 0,
    backgroundColor: "rgba(0,0,0,0.4)",
    zIndex: 99,
  },
  // Mobile layout styles
  mobileRoot: {
    display: "flex",
    flexDirection: "column",
    height: "100dvh",
    maxHeight: "100dvh",
    overflow: "hidden",
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    paddingTop: "env(safe-area-inset-top)",
    paddingBottom: "env(safe-area-inset-bottom)",
  },
  mobileContent: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    overflowX: "hidden",
    padding: "12px",
    WebkitOverflowScrolling: "touch",
  },
});

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const styles = useStyles();
  const [navOpen, setNavOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [width, setWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const handler = () => setWidth(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  const isWide = width >= 1280;
  const isMedium = width >= 960 && width < 1280;
  const isMobileOrCompact = width < 960;

  const toggleNav = useCallback(() => setNavOpen((o) => !o), []);
  const toggleChat = useCallback(() => setChatOpen((o) => !o), []);
  const closeNav = useCallback(() => setNavOpen(false), []);
  const closeChat = useCallback(() => setChatOpen(false), []);

  const showNavInline = isWide;
  const showChatInline = isWide || isMedium;
  const showNavButton = !showNavInline;
  const showChatButton = !showChatInline;

  // Mobile layout
  if (isMobileOrCompact) {
    return (
      <div className={styles.mobileRoot}>
        <MobileHeader />
        <main className={styles.mobileContent}>
          {children}
        </main>
        <BottomTabBar
          onOpenRooms={() => setNavOpen(true)}
          onOpenChat={() => setChatOpen(true)}
        />

        {/* Nav as fullscreen drawer from left */}
        {navOpen && (
          <MobileDrawer position="left" onClose={closeNav}>
            <NavPanel onNavigate={closeNav} mobile />
          </MobileDrawer>
        )}

        {/* Chat as fullscreen sheet from bottom */}
        {chatOpen && (
          <MobileDrawer position="bottom" onClose={closeChat}>
            <ChatPanel mobile />
          </MobileDrawer>
        )}
      </div>
    );
  }

  // Desktop / tablet layout
  return (
    <div className={styles.root}>
      {!showNavInline && (
        <Header
          onToggleNav={toggleNav}
          onToggleChat={toggleChat}
          showNavButton={showNavButton}
          showChatButton={showChatButton}
        />
      )}
      <div className={styles.body}>
        {/* Nav panel */}
        {showNavInline && (
          <NavPanel
            onNavigate={() => {}}
            showHeader
            onToggleChat={toggleChat}
            showChatButton={showChatButton}
          />
        )}
        {!showNavInline && navOpen && (
          <>
            <div className={styles.overlay} onClick={closeNav} />
            <NavPanel onNavigate={closeNav} overlay />
          </>
        )}

        {/* Main content */}
        <main className={styles.content}>
          {children}
        </main>

        {/* Chat panel */}
        {showChatInline && <ChatPanel />}
        {!showChatInline && chatOpen && (
          <>
            <div className={styles.overlay} onClick={closeChat} />
            <ChatPanel overlay />
          </>
        )}
      </div>
    </div>
  );
}
