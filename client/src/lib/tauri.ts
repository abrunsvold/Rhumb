import { invoke, Channel } from "@tauri-apps/api/core";
import type { AgentEvent, RegistrySnapshot } from "./types";

export interface AppConfig {
  agentBase: string;
  dashboardBase: string;
}

export function getConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("get_config");
}

export function setConfig(config: AppConfig): Promise<void> {
  return invoke("set_config", { config });
}

export function checkHealth(base: string): Promise<boolean> {
  return invoke<boolean>("check_health", { base });
}

export function sendMessage(
  agentBase: string,
  turnId: string,
  prompt: string,
  sessionId?: string,
): Promise<void> {
  return invoke("send_message", { agentBase, turnId, prompt, sessionId: sessionId ?? null });
}

export function openAgentStream(
  agentBase: string,
  turnId: string,
  onEvent: (e: AgentEvent) => void,
): () => void {
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  void invoke("start_agent_stream", { agentBase, turnId, onEvent: channel });
  return () => void invoke("stop_agent_stream", { turnId });
}

export function getRegistry(dashboardBase: string): Promise<RegistrySnapshot> {
  return invoke<RegistrySnapshot>("get_registry", { dashboardBase });
}

export function openRegistryStream(
  dashboardBase: string,
  onUpdate: (s: RegistrySnapshot) => void,
): () => void {
  const channel = new Channel<RegistrySnapshot>();
  channel.onmessage = onUpdate;
  void invoke("start_registry_stream", { dashboardBase, onUpdate: channel });
  return () => void invoke("stop_registry_stream");
}
