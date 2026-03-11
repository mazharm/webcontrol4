import { useState, useCallback } from "react";
import { makeStyles, tokens, Input, Button } from "@fluentui/react-components";
import { Send24Regular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  root: {
    display: "flex",
    gap: "8px",
    padding: "8px",
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  input: { flex: 1 },
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
      <Input
        className={styles.input}
        value={text}
        onChange={(_, d) => setText(d.value)}
        placeholder="Type a message..."
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        disabled={disabled}
      />
      <Button icon={<Send24Regular />} appearance="primary" onClick={send} disabled={disabled || !text.trim()} aria-label="Send" />
    </div>
  );
}
