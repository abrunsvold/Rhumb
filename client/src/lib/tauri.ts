import { invoke, Channel } from "@tauri-apps/api/core";
import type { AgentEvent, RegistrySnapshot, SessionMeta } from "./types";
import type { TranscriptMessage } from "./agentEvents";

export interface AppConfig {
  // Single tailscale-serve origin; per-host bases derive from the manifest paths.
  baseUrl: string;
  agentPath: string;
  dashboardPath: string;
  // Dev-mode hosts only; no UI field (hand-edit config.json for local dev).
  controlToken?: string;
}

export interface DiscoveredHost {
  baseUrl: string;
  version: string;
}

export interface ProbeAttempt {
  peer: string;
  target: string;
  outcome: "matched" | "unreachable" | "not-rhumb" | "bad-response";
}

export interface DiscoveryReport {
  hosts: DiscoveredHost[];
  scanned: number;
  attempts: ProbeAttempt[];
}

export interface RhumbManifest {
  rhumb: boolean;
  version: string;
  paths: { agent: string; dashboard: string };
}

function joinBase(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.replace(/\/+$/, "");
  if (p === "") return b;
  return p.startsWith("/") ? `${b}${p}` : `${b}/${p}`;
}

export function agentBaseOf(c: AppConfig): string {
  return joinBase(c.baseUrl, c.agentPath);
}

export function dashboardBaseOf(c: AppConfig): string {
  return joinBase(c.baseUrl, c.dashboardPath);
}

export function discoverHosts(): Promise<DiscoveryReport> {
  return invoke<DiscoveryReport>("discover_hosts");
}

export function fetchManifest(baseUrl: string): Promise<RhumbManifest> {
  return invoke<RhumbManifest>("fetch_manifest", { baseUrl });
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

// Probe an identity-gated route (registry) before persisting config: /healthz
// is open, so health checks alone cannot tell a non-allowlisted device apart
// from a working one. Resolves to the HTTP status (200 allowlisted, 403 not).
export function checkIdentity(dashboardBase: string): Promise<number> {
  return invoke<number>("check_identity", { base: dashboardBase });
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
