import { useState, useCallback } from "react";
import { makeStyles, tokens, Button, Text } from "@fluentui/react-components";
import { ArrowUp24Regular } from "@fluentui/react-icons";

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
    flexDirection: "column",
    gap: "8px",
  },
  inputWrapper: {
    display: "flex",
    alignItems: "flex-end",
    gap: "8px",
    padding: "8px",
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    ":focus-within": {
      border: `1px solid ${tokens.colorBrandBackground}`,
      outline: "2px solid transparent",
    },
  },
  input: {
    flex: 1,
    minHeight: "64px",
    maxHeight: "220px",
    resize: "none",
    border: "none",
    outline: "none",
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground1,
    padding: "4px",
    font: "inherit",
    lineHeight: "1.5",
  },
  sendButton: {
    flexShrink: 0,
    marginBottom: "2px",
  },
  helperText: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    paddingLeft: "4px",
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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Auto-resize textarea
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`;
  };

  return (
    <div className={styles.root}>
      <div className={styles.composerRow}>
        <div className={styles.inputWrapper}>
          <textarea
            className={styles.input}
            value={text}
            onChange={handleInput}
            placeholder="Type a message..."
            onKeyDown={handleKeyDown}
            disabled={disabled}
            rows={1}
          />
          <Button
            className={styles.sendButton}
            icon={<ArrowUp24Regular />}
            appearance="primary"
            onClick={send}
            disabled={disabled || !text.trim()}
            aria-label="Send"
            size="small"
            shape="circular"
          />
        </div>
        <Text className={styles.helperText}>Press Enter to send. Use Shift+Enter for a new line.</Text>
      </div>
    </div>
  );
}
