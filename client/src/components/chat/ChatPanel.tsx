import { useCallback } from "react";
import { makeStyles, tokens, Button, Text } from "@fluentui/react-components";
import { Delete24Regular } from "@fluentui/react-icons";
import { useChat } from "../../contexts/ChatContext";
import { useDevices } from "../../hooks/useDevices";
import { chatWithLLM } from "../../api/llm";
import { getRoutines } from "../../api/routines";
import { isRemoteMode } from "../../config/transport";
import { llmChat as mqttLlmChat } from "../../services/mqtt-rpc";
import { ChatMessages } from "./ChatMessages";
import { ChatInput } from "./ChatInput";
import type { LLMControlContext } from "../../types/api";
import type { UnifiedDevice, LightState, ThermostatState } from "../../types/devices";

const useStyles = makeStyles({
  root: {
    width: "340px",
    minWidth: "300px",
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    borderLeft: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
  },
  overlay: {
    position: "fixed",
    top: "48px",
    right: 0,
    bottom: 0,
    zIndex: 100,
  },
  mobileRoot: {
    width: "100%",
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    flex: 1,
    borderLeft: "none",
    backgroundColor: tokens.colorNeutralBackground2,
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexShrink: 0,
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
  mobile?: boolean;
}

export function ChatPanel({ overlay, mobile }: ChatPanelProps) {
  const styles = useStyles();
  const { state, dispatch } = useChat();
  const { devices } = useDevices();

  const buildLlmContext = useCallback(async (): Promise<LLMControlContext> => {
    const control4Devices = Array.from(devices.values())
      .filter((device): device is UnifiedDevice => device.source === "control4" && (device.type === "light" || device.type === "thermostat"))
      .map((device) => {
        const numericId = Number(device.id.replace("control4:", ""));
        if (device.type === "light") {
          const state = device.state as LightState;
          return {
            id: numericId,
            type: "light" as const,
            name: device.name,
            floor: device.floorName,
            room: device.roomName,
            on: state.on,
            level: state.level,
          };
        }

        const state = device.state as ThermostatState;
        return {
          id: numericId,
          type: "thermostat" as const,
          name: device.name,
          floor: device.floorName,
          room: device.roomName,
          tempF: state.currentTempF,
          heatF: state.heatSetpointF,
          coolF: state.coolSetpointF,
          hvacMode: state.hvacMode,
        };
      });

    let routines: LLMControlContext["routines"] = [];
    if (!isRemoteMode()) {
      try {
        const savedRoutines = await getRoutines();
        routines = savedRoutines.map((routine) => ({ id: routine.id, name: routine.name }));
      } catch {
        routines = [];
      }
    }

    return { devices: control4Devices, routines };
  }, [devices]);

  const handleSend = useCallback(async (message: string) => {
    dispatch({
      type: "ADD_MESSAGE",
      payload: { id: `user-${Date.now()}`, role: "user", content: message, timestamp: Date.now() },
    });
    dispatch({ type: "SET_PENDING", payload: true });

    try {
      const context = await buildLlmContext();
      const response = isRemoteMode()
        ? await mqttLlmChat({ message, context: context as Record<string, unknown>, mode: "control" })
        : await chatWithLLM({ message, context, mode: "control" });
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
    } finally {
      dispatch({ type: "SET_PENDING", payload: false });
    }
  }, [buildLlmContext, dispatch]);

  const rootClass = mobile
    ? styles.mobileRoot
    : `${styles.root} ${overlay ? styles.overlay : ""}`;

  return (
    <div className={rootClass}>
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
