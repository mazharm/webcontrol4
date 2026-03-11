import { createContext, useContext, useReducer, type ReactNode, type Dispatch } from "react";
import type { Controller } from "../types/devices";

export type AuthStage = "checking" | "login" | "controller-select" | "connected";

export interface AuthState {
  stage: AuthStage;
  accountToken: string | null;
  controllerIp: string | null;
  directorToken: string | null;
  controllers: Controller[];
  googleAuth: { email: string } | null;
  error: string | null;
}

export type AuthAction =
  | { type: "SET_STAGE"; payload: AuthStage }
  | { type: "SET_ACCOUNT_TOKEN"; payload: string }
  | { type: "SET_CONTROLLERS"; payload: Controller[] }
  | { type: "SET_DIRECTOR"; payload: { ip: string; token: string } }
  | { type: "SET_GOOGLE_AUTH"; payload: { email: string } }
  | { type: "SET_ERROR"; payload: string | null }
  | { type: "LOGOUT" };

const initialState: AuthState = {
  stage: "checking",
  accountToken: null,
  controllerIp: null,
  directorToken: null,
  controllers: [],
  googleAuth: null,
  error: null,
};

function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case "SET_STAGE":
      return { ...state, stage: action.payload, error: null };
    case "SET_ACCOUNT_TOKEN":
      return { ...state, accountToken: action.payload };
    case "SET_CONTROLLERS":
      return { ...state, controllers: action.payload, stage: "controller-select" };
    case "SET_DIRECTOR":
      return { ...state, controllerIp: action.payload.ip, directorToken: action.payload.token, stage: "connected" };
    case "SET_GOOGLE_AUTH":
      return { ...state, googleAuth: action.payload };
    case "SET_ERROR":
      return { ...state, error: action.payload };
    case "LOGOUT":
      return { ...initialState, stage: "login" };
    default:
      return state;
  }
}

interface AuthContextValue {
  state: AuthState;
  dispatch: Dispatch<AuthAction>;
}

const AuthContext = createContext<AuthContextValue>({
  state: initialState,
  dispatch: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(authReducer, initialState);
  return (
    <AuthContext.Provider value={{ state, dispatch }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
