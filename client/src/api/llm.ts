import type { LLMChatRequest, LLMChatResponse } from "../types/api";
import { safeJson } from "./safeJson";

export async function chatWithLLM(request: LLMChatRequest): Promise<LLMChatResponse> {
  const res = await fetch("/api/llm/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new Error("LLM chat failed");
  return safeJson<LLMChatResponse>(res, "LLM chat failed");
}

export async function getModels(): Promise<string[]> {
  const res = await fetch("/api/llm/models");
  if (!res.ok) throw new Error("Failed to fetch models");
  return safeJson<string[]>(res, "Failed to fetch models");
}
