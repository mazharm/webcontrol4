import type { LLMChatRequest, LLMChatResponse } from "../types/api";

export async function chatWithLLM(request: LLMChatRequest): Promise<LLMChatResponse> {
  const res = await fetch("/api/llm/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new Error("LLM chat failed");
  return res.json();
}

export async function getModels(): Promise<string[]> {
  const res = await fetch("/api/llm/models");
  if (!res.ok) throw new Error("Failed to fetch models");
  return res.json();
}
