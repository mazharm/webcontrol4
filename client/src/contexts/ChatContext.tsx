import { createContext, useContext, useReducer, type ReactNode, type Dispatch } from "react";
import type { LLMAction } from "../types/api";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
  actions?: LLMAction[];
  timestamp: number;
}

interface ChatState {
  messages: ChatMessage[];
  pending: boolean;
}

export type ChatAction =
  | { type: "ADD_MESSAGE"; payload: ChatMessage }
  | { type: "SET_PENDING"; payload: boolean }
  | { type: "CLEAR" };

const initialState: ChatState = { messages: [], pending: false };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "ADD_MESSAGE":
      return { ...state, messages: [...state.messages, action.payload].slice(-200), pending: false };
    case "SET_PENDING":
      return { ...state, pending: action.payload };
    case "CLEAR":
      return initialState;
    default:
      return state;
  }
}

interface ChatContextValue {
  state: ChatState;
  dispatch: Dispatch<ChatAction>;
}

const ChatContext = createContext<ChatContextValue>({
  state: initialState,
  dispatch: () => {},
});

export function ChatProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(chatReducer, initialState);
  return (
    <ChatContext.Provider value={{ state, dispatch }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  return useContext(ChatContext);
}
