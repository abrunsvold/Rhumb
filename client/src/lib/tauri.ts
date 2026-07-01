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

export function openPendingStream(
  dashboardBase: string,
  onPending: (e: unknown) => void,
): () => void {
  const channel = new Channel<unknown>();
  channel.onmessage = onPending;
  void invoke("start_pending_stream", { dashboardBase, onPending: channel });
  return () => void invoke("stop_pending_stream");
}

export function resolvePending(
  dashboardBase: string,
  pendingId: string,
  decision: "approve" | "deny",
  trustSurface: boolean,
): Promise<void> {
  return invoke("resolve_pending", { dashboardBase, pendingId, decision, trustSurface });
}

export function openInfraPendingStream(agentBase: string, onPending: (e: unknown) => void): () => void {
  const channel = new Channel<unknown>();
  channel.onmessage = onPending;
  void invoke("start_infra_pending_stream", { agentBase, onPending: channel });
  return () => void invoke("stop_infra_pending_stream");
}

export function resolveInfraPending(agentBase: string, pendingId: string, decision: "approve" | "deny"): Promise<void> {
  return invoke("resolve_infra_pending", { agentBase, pendingId, decision });
}
