import { useCallback } from "react";
import { makeStyles, tokens, Button, Text } from "@fluentui/react-components";
import { Delete24Regular } from "@fluentui/react-icons";
import { useChat } from "../../contexts/ChatContext";
import { useDeviceSummary } from "../../hooks/useDevices";
import { chatWithLLM } from "../../api/llm";
import { ChatMessages } from "./ChatMessages";
import { ChatInput } from "./ChatInput";

const useStyles = makeStyles({
  root: {
    width: "340px",
    minWidth: "300px",
    display: "flex",
    flexDirection: "column",
    borderLeft: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
    height: "100%",
  },
  overlay: {
    position: "fixed",
    top: "48px",
    right: 0,
    bottom: 0,
    zIndex: 100,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 12px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  title: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase400,
  },
});

interface ChatPanelProps {
  overlay?: boolean;
}

export function ChatPanel({ overlay }: ChatPanelProps) {
  const styles = useStyles();
  const { state, dispatch } = useChat();
  const deviceSummary = useDeviceSummary();

  const handleSend = useCallback(async (message: string) => {
    dispatch({
      type: "ADD_MESSAGE",
      payload: { id: `user-${Date.now()}`, role: "user", content: message, timestamp: Date.now() },
    });
    dispatch({ type: "SET_PENDING", payload: true });

    try {
      const response = await chatWithLLM({
        message,
        context: deviceSummary,
        mode: "control",
      });
      dispatch({
        type: "ADD_MESSAGE",
        payload: {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: response.message,
          actions: response.actions,
          timestamp: Date.now(),
        },
      });
    } catch (err) {
      dispatch({
        type: "ADD_MESSAGE",
        payload: {
          id: `error-${Date.now()}`,
          role: "error",
          content: err instanceof Error ? err.message : "Failed to get response",
          timestamp: Date.now(),
        },
      });
    }
  }, [dispatch, deviceSummary]);

  return (
    <div className={`${styles.root} ${overlay ? styles.overlay : ""}`}>
      <div className={styles.header}>
        <Text className={styles.title}>Assistant</Text>
        <Button
          icon={<Delete24Regular />}
          appearance="subtle"
          size="small"
          onClick={() => dispatch({ type: "CLEAR" })}
          aria-label="Clear chat"
        />
      </div>
      <ChatMessages />
      <ChatInput onSend={handleSend} disabled={state.pending} />
    </div>
  );
}
