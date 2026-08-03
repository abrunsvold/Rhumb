import type { AgentEvent, TranscriptMessage } from "../types.js";

export type BackendId = "sdk" | "mngr";

/** Identity of one agent.
 *
 *  `agentId` is the durable, Rhumb-owned principal. Rhumb mints and persists
 *  it, and slice 3's trust edges key on it.
 *
 *  `nativeId` is the backend's own handle — an SDK session_id, or an mngr
 *  agent id. mngr ids are plaintext, settable via `mngr create --id`, and
 *  carry no attestation, so a nativeId is an IDENTIFIER, NEVER A CREDENTIAL.
 *  A mngr fork mints a fresh nativeId, so a forked agent inherits no trust. */
export interface AgentRef {
  agentId: string;
  nativeId: string | null;
  backend: BackendId;
}

export interface AgentSpec {
  model: string;
  workspace: string;
  permissionMode: string;
  extraOptions: Record<string, unknown>;
}

export interface AgentBackend {
  readonly id: BackendId;
  /** Idempotent: ensure a live agent exists for this Rhumb principal. */
  ensure(agentId: string, spec: AgentSpec): Promise<AgentRef>;
  /** Send a prompt, streaming events. Returns the ref, whose nativeId may be
   *  populated during the turn (the SDK learns its session_id mid-stream). */
  send(ref: AgentRef, prompt: string, onEvent: (e: AgentEvent) => void): Promise<AgentRef>;
  list(): Promise<AgentRef[]>;
  stop(ref: AgentRef): Promise<void>;
  transcript(ref: AgentRef): Promise<TranscriptMessage[] | null>;
}
