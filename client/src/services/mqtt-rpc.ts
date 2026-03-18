// ---------------------------------------------------------------------------
// services/mqtt-rpc.ts – RPC request/response client over MQTT
// ---------------------------------------------------------------------------

import { subscribe, publish } from "./mqtt-client";
import { getMqttConfig } from "../config/transport";

const RPC_TIMEOUT_MS = 15_000;

let requestCounter = 0;

function generateRequestId(): string {
  requestCounter++;
  return `${Date.now()}-${requestCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Make an RPC call over MQTT.
 * Publishes a request and waits for the response on a per-request topic.
 */
export function rpcCall<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
  const config = getMqttConfig();
  const requestId = generateRequestId();
  const requestTopic = `wc4/${config.homeId}/rpc/request`;
  const responseTopic = `wc4/${config.homeId}/rpc/response/${requestId}`;

  return new Promise<T>((resolve, reject) => {
    const effectiveTimeout = timeoutMs ?? RPC_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`RPC timeout: ${method} (${effectiveTimeout}ms)`));
    }, effectiveTimeout);

    const unsubscribe = subscribe(responseTopic, (payload: unknown) => {
      clearTimeout(timeout);
      unsubscribe();

      const response = payload as { id: string; result?: T; error?: string };
      if (response.error) {
        reject(new Error(response.error));
      } else {
        resolve(response.result as T);
      }
    });

    const published = publish(requestTopic, { id: requestId, method, params });
    if (!published) {
      clearTimeout(timeout);
      unsubscribe();
      reject(new Error(`RPC call failed: MQTT client not connected (method: ${method})`));
    }
  });
}

// Convenience wrappers

export interface SnapshotResult {
  image: string;
  cameraId: string;
  ts: string;
}

export function getSnapshot(cameraId: string): Promise<SnapshotResult> {
  return rpcCall<SnapshotResult>("getSnapshot", { cameraId }, 30_000);
}

export interface TrendingResult {
  deviceId: string;
  events?: Array<{ item_id: number; var_name: string; value: string; old_value: string; timestamp: number }>;
  points?: Array<{ date: string; event_count: number; min_value: number; max_value: number; avg_value: number; total_on_minutes: number }>;
  variable?: string;
  ts: string;
}

export function getTrending(deviceId: string, variable?: string, days?: number): Promise<TrendingResult> {
  return rpcCall<TrendingResult>("getTrending", { deviceId, variable, days });
}

export interface HistoryResult {
  deviceId: string;
  events: Array<{ item_id: number; var_name: string; value: string; old_value: string; timestamp: number }>;
  ts: string;
}

export function getHistory(deviceId: string, hours?: number, limit?: number): Promise<HistoryResult> {
  return rpcCall<HistoryResult>("getHistory", { deviceId, hours, limit });
}

export interface DailySummaryResult {
  deviceId: string;
  summary: Array<{ item_id: number; var_name: string; date: string; event_count: number; min_value: number; max_value: number; avg_value: number; total_on_minutes: number }>;
  ts: string;
}

export function getDailySummary(deviceId: string, days?: number): Promise<DailySummaryResult> {
  return rpcCall<DailySummaryResult>("getDailySummary", { deviceId, days });
}

import type { HistoryPoint } from "../types/api";
import type { Routine } from "../types/devices";

export function getRemoteRoutines(): Promise<Routine[]> {
  return rpcCall<Routine[]>("getRoutines");
}

export function getAppHistory(type: "light" | "thermo" | "floor", id: string): Promise<HistoryPoint[]> {
  return rpcCall<HistoryPoint[]>("getAppHistory", { type, id });
}

import type { LLMAction } from "../types/api";

export interface LlmChatResult {
  message: string;
  actions?: LLMAction[];
}

export function llmChat(params: {
  message?: string;
  messages?: Array<{ role: string; content: string }>;
  context?: Record<string, unknown>;
  mode?: string;
}): Promise<LlmChatResult> {
  return rpcCall<LlmChatResult>("llmChat", params as Record<string, unknown>, 60_000);
}
