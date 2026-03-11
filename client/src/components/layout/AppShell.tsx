import { useState, useCallback, type ReactNode } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import { Header } from "./Header";
import { NavPanel } from "./NavPanel";
import { ChatPanel } from "../chat/ChatPanel";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
  },
  body: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
  },
  content: {
    flex: 1,
    overflow: "auto",
    padding: "16px",
  },
  overlay: {
    position: "fixed",
    inset: 0,
    backgroundColor: "rgba(0,0,0,0.4)",
    zIndex: 99,
  },
});

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const styles = useStyles();
  const [navOpen, setNavOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [width, setWidth] = useState(window.innerWidth);

  // Track window width for responsive
  useState(() => {
    const handler = () => setWidth(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  });

  const isWide = width >= 1280;
  const isMedium = width >= 960 && width < 1280;

  const toggleNav = useCallback(() => setNavOpen((o) => !o), []);
  const toggleChat = useCallback(() => setChatOpen((o) => !o), []);
  const closeNav = useCallback(() => setNavOpen(false), []);
  const closeChat = useCallback(() => setChatOpen(false), []);

  const showNavInline = isWide;
  const showChatInline = isWide || isMedium;
  const showNavButton = !showNavInline;
  const showChatButton = !showChatInline;

  return (
    <div className={styles.root}>
      <Header
        onToggleNav={toggleNav}
        onToggleChat={toggleChat}
        showNavButton={showNavButton}
        showChatButton={showChatButton}
      />
      <div className={styles.body}>
        {/* Nav panel */}
        {showNavInline && <NavPanel onNavigate={() => {}} />}
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
