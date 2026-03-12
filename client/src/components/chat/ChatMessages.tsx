import { useRef, useEffect } from "react";
import { makeStyles, Spinner } from "@fluentui/react-components";
import { useChat } from "../../contexts/ChatContext";
import { ChatBubble } from "./ChatBubble";
import { ActionPreview } from "./ActionPreview";

const useStyles = makeStyles({
  root: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    overflowX: "hidden",
    padding: "8px",
  },
  spinner: {
    display: "flex",
    justifyContent: "center",
    padding: "8px",
  },
});

export function ChatMessages() {
  const styles = useStyles();
  const { state, dispatch } = useChat();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages.length, state.pending]);

  return (
    <div className={styles.root}>
      {state.messages.map((msg) => (
        <div key={msg.id}>
          <ChatBubble message={msg} />
          {msg.actions && msg.actions.length > 0 && (
            <ActionPreview
              actions={msg.actions}
              onComplete={() => {
                dispatch({
                  type: "ADD_MESSAGE",
                  payload: {
                    id: `done-${msg.id}`,
                    role: "assistant",
                    content: "Actions executed.",
                    timestamp: Date.now(),
                  },
                });
              }}
            />
          )}
        </div>
      ))}
      {state.pending && (
        <div className={styles.spinner}><Spinner size="tiny" /></div>
      )}
      <div ref={endRef} />
    </div>
  );
}
