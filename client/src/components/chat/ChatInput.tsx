import { useState, useCallback } from "react";
import { makeStyles, tokens, Button, Text } from "@fluentui/react-components";
import { Send24Regular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    flexShrink: 0,
    padding: "12px",
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  composerRow: {
    display: "flex",
    gap: "8px",
    alignItems: "flex-end",
  },
  input: {
    flex: 1,
    minHeight: "104px",
    maxHeight: "220px",
    resize: "vertical",
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    padding: "12px",
    font: "inherit",
    lineHeight: "1.5",
    outlineStyle: "none",
  },
  sendButton: {
    flexShrink: 0,
  },
  helperText: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const styles = useStyles();
  const [text, setText] = useState("");

  const send = useCallback(() => {
    const msg = text.trim();
    if (!msg) return;
    onSend(msg);
    setText("");
  }, [text, onSend]);

  return (
    <div className={styles.root}>
      <div className={styles.composerRow}>
        <textarea
          className={styles.input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a message..."
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          disabled={disabled}
        />
        <Button
          className={styles.sendButton}
          icon={<Send24Regular />}
          appearance="primary"
          onClick={send}
          disabled={disabled || !text.trim()}
          aria-label="Send"
        />
      </div>
      <Text className={styles.helperText}>Press Enter to send. Use Shift+Enter for a new line.</Text>
    </div>
  );
}
