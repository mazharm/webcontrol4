import { makeStyles, tokens } from "@fluentui/react-components";
import type { ChatMessage } from "../../contexts/ChatContext";

const useStyles = makeStyles({
  root: {
    marginBottom: "8px",
    display: "flex",
  },
  user: { justifyContent: "flex-end" },
  assistant: { justifyContent: "flex-start" },
  error: { justifyContent: "flex-start" },
  bubble: {
    maxWidth: "85%",
    padding: "8px 12px",
    borderRadius: tokens.borderRadiusMedium,
    fontSize: tokens.fontSizeBase300,
    lineHeight: "1.4",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  userBubble: {
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
  },
  assistantBubble: {
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
  },
  errorBubble: {
    backgroundColor: tokens.colorPaletteRedBackground2,
    color: tokens.colorPaletteRedForeground2,
  },
});

export function ChatBubble({ message }: { message: ChatMessage }) {
  const styles = useStyles();

  const alignClass = message.role === "user" ? styles.user : styles.assistant;
  const bubbleClass = message.role === "user"
    ? styles.userBubble
    : message.role === "error"
    ? styles.errorBubble
    : styles.assistantBubble;

  return (
    <div className={`${styles.root} ${alignClass}`}>
      <div className={`${styles.bubble} ${bubbleClass}`}>
        {message.content}
      </div>
    </div>
  );
}
