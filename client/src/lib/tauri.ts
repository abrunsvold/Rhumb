import { invoke, Channel } from "@tauri-apps/api/core";
import type { AgentEvent, RegistrySnapshot, SessionMeta } from "./types";
import type { TranscriptMessage } from "./agentEvents";

export interface AppConfig {
  agentBase: string;
  dashboardBase: string;
  // Optional shared operator secret (RHUMB_CONTROL_TOKEN). The Rust proxy reads it
  // from persisted config and sends it as a Bearer header on control-plane calls;
  // it is never passed per-call over IPC.
  controlToken?: string;
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

export function uploadFile(agentBase: string, name: string, contentBase64: string): Promise<string> {
  return invoke<string>("upload_file", { agentBase, name, contentBase64 });
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

export async function listSessions(agentBase: string): Promise<SessionMeta[]> {
  const r = await invoke<{ sessions: SessionMeta[] }>("list_sessions", { agentBase });
  return r.sessions;
}

export async function getTranscript(agentBase: string, sessionId: string): Promise<TranscriptMessage[]> {
  const r = await invoke<{ messages: TranscriptMessage[] }>("get_transcript", { agentBase, sessionId });
  return r.messages;
}

export function renameSession(agentBase: string, sessionId: string, title: string): Promise<void> {
  return invoke("rename_session", { agentBase, sessionId, title });
}

export function archiveSession(agentBase: string, sessionId: string): Promise<void> {
  return invoke("archive_session", { agentBase, sessionId });
}

export function openSessionStream(
  agentBase: string,
  sessionId: string,
  onEvent: (e: unknown) => void,
): () => void {
  const channel = new Channel<unknown>();
  channel.onmessage = onEvent;
  void invoke("start_session_stream", { agentBase, sessionId, onEvent: channel });
  return () => void invoke("stop_session_stream", { sessionId });
}
