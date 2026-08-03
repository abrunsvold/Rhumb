import type { TranscriptMessage } from "../types.js";
import type { AgentBackend, AgentRef, AgentSpec } from "./types.js";
import type { AgentRegistry } from "../agents.js";
import { PROVIDER_CREDENTIAL_VARS } from "../provider.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  argv: string[],
  opts?: { env?: Record<string, string> },
) => Promise<ExecResult>;

// Command shapes verified against mngr 0.2.17 in
// docs/dogfood/2026-08-03-mngr-phase0.md. Adjust these builders — and
// nothing else — if the CLI surface changes.
const argvCreate = (name: string, credentialEnv: Record<string, string>): string[] => [
  "create",
  name,
  "claude",
  "--no-connect",
  "-y",
  ...credentialEnvFlags(credentialEnv),
];
const argvSend = (nativeId: string, prompt: string): string[] => ["message", nativeId, "-m", prompt];
const argvStop = (nativeId: string): string[] => ["stop", nativeId];
const argvList = (): string[] => ["list", "--format", "json"];
const argvTranscript = (nativeId: string): string[] => ["transcript", nativeId, "--format", "jsonl"];

/** mngr does not scrub the ambient environment: the spawned agent's env
 *  comes from whatever the tmux server was started with, not from the env of
 *  the `mngr` process that requested it (docs/dogfood/2026-08-03-mngr-phase0.md,
 *  Q2). A pre-existing tmux server bypasses a clean child-process env
 *  entirely, so the only verified remedy is an explicit `--env` for EVERY
 *  entry in PROVIDER_CREDENTIAL_VARS: the selected provider's value where
 *  present, and every other entry blanked with `--env VAR=`. Passing only
 *  the selected provider's credentials is NOT sufficient — any unmentioned
 *  var is inherited from the tmux server. */
function credentialEnvFlags(credentialEnv: Record<string, string>): string[] {
  const flags: string[] = [];
  for (const key of PROVIDER_CREDENTIAL_VARS) {
    const value = credentialEnv[key];
    flags.push("--env", `${key}=${value ?? ""}`);
  }
  return flags;
}

/** Maps one line of `mngr transcript --format jsonl` output to a
 *  TranscriptMessage. mngr's transcript is agent-agnostic and may carry
 *  event types Rhumb has no use for, so unrecognised types — and
 *  unparseable lines — are skipped rather than thrown. */
function parseTranscriptLine(line: string): TranscriptMessage | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (e.type === "user_message") {
    return { kind: "user", text: typeof e.content === "string" ? e.content : "" };
  }
  if (e.type === "assistant_message") {
    return { kind: "text", text: typeof e.text === "string" ? e.text : "" };
  }
  return null;
}

/** Runs Claude Code through the mngr CLI instead of in-process.
 *
 *  `ensure` binds a Rhumb principal to a mngr agent id. The binding is
 *  recorded in the registry, never derived from mngr — mngr ids are
 *  plaintext and settable, so they are looked up, not trusted. */
export function createMngrBackend(deps: {
  exec: ExecFn;
  registry: AgentRegistry;
  /** Exactly the credential vars the spawned agent may see. Built by
   *  provider.ts / env.ts; nothing ambient is added here. */
  credentialEnv: Record<string, string>;
  spec: AgentSpec;
}): AgentBackend {
  const { exec, registry, credentialEnv } = deps;

  /** Live mngr agent ids, or `null` when liveness is unknowable (non-zero
   *  exit or unparseable output). `null` means "do not conclude anything" —
   *  never "nothing is alive". */
  async function liveIds(): Promise<Set<string> | null> {
    const res = await exec(argvList());
    if (res.code !== 0) return null;
    try {
      const parsed = JSON.parse(res.stdout) as { agents?: Array<{ id?: string }> };
      if (!parsed || !Array.isArray(parsed.agents)) return null;
      const ids = new Set<string>();
      for (const a of parsed.agents) if (a?.id) ids.add(a.id);
      return ids;
    } catch {
      return null;
    }
  }

  /** Snapshot of a live agent's transcript, or `null` when it cannot be read
   *  (non-zero exit). Individual unparseable or unrecognised lines are
   *  skipped, never thrown — see parseTranscriptLine. */
  async function fetchTranscript(nativeId: string): Promise<TranscriptMessage[] | null> {
    const res = await exec(argvTranscript(nativeId));
    if (res.code !== 0) return null;
    const messages: TranscriptMessage[] = [];
    for (const line of res.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const msg = parseTranscriptLine(trimmed);
      if (msg) messages.push(msg);
    }
    return messages;
  }

  async function ensureAgent(agentId: string): Promise<AgentRef> {
    const existing = registry.get(agentId);
    if (existing?.nativeId) {
      // A bound agent may have died (host reboot, tmux kill). Re-create
      // rather than failing the turn. Liveness must be PROVEN false before
      // respawning: if `list` errors or is unparseable we cannot tell, and
      // assuming "dead" there would spawn a duplicate on every hiccup.
      const live = await liveIds();
      if (live === null || live.has(existing.nativeId)) {
        return { agentId, nativeId: existing.nativeId, backend: "mngr" };
      }
    }
    const name = existing?.name ?? agentId;
    const res = await exec(argvCreate(name, credentialEnv), { env: credentialEnv });
    if (res.code !== 0) {
      // Leave the principal unbound; send() reports the failure as an error
      // event on the turn rather than throwing here.
      return { agentId, nativeId: null, backend: "mngr" };
    }
    const nativeId = res.stdout.trim();
    if (nativeId) registry.bind(agentId, nativeId);
    return { agentId, nativeId: nativeId || null, backend: "mngr" };
  }

  return {
    id: "mngr",

    async ensure(agentId) {
      return ensureAgent(agentId);
    },

    async send(ref, prompt, onEvent) {
      let nativeId = ref.nativeId;
      if (!nativeId) {
        const ensured = await ensureAgent(ref.agentId);
        nativeId = ensured.nativeId;
        if (!nativeId) {
          onEvent({ type: "error", message: "mngr: could not create an agent for this principal" });
          return { ...ref, nativeId: null };
        }
      }

      onEvent({ type: "session", sessionId: nativeId });

      // `mngr message` has been observed to exit non-zero on a message it
      // actually delivered (docs/dogfood/2026-08-03-mngr-phase0.md, Q1: a
      // 90s "timeout waiting for message submission signal" while the
      // transcript proved the turn was answered). A non-zero exit is
      // therefore NOT proof of non-delivery — reconcile against the
      // transcript before surfacing an error. "Delivered" is defined as
      // "the transcript grew since before the call", independent of exact
      // content, which keeps the reconciliation simple and CLI-shape-agnostic.
      const before = await fetchTranscript(nativeId);
      const beforeCount = before?.length ?? 0;

      const res = await exec(argvSend(nativeId, prompt), { env: credentialEnv });

      const after = await fetchTranscript(nativeId);

      if (res.code !== 0) {
        if (after !== null && after.length > beforeCount) {
          // Delivered despite the non-zero exit: report what the transcript
          // actually shows, not the CLI's exit code.
          registry.touch(ref.agentId);
          const last = after[after.length - 1];
          onEvent({ type: "result", result: last?.text ?? "", isError: false });
          return { ...ref, nativeId };
        }
        onEvent({ type: "error", message: `mngr: ${res.stderr.trim() || `exit ${res.code}`}` });
        return { ...ref, nativeId };
      }

      registry.touch(ref.agentId);
      const last = after && after.length > 0 ? after[after.length - 1] : null;
      onEvent({ type: "result", result: last?.text ?? res.stdout.trim(), isError: false });
      return { ...ref, nativeId };
    },

    async list(): Promise<AgentRef[]> {
      // The registry is the source of truth for principals; mngr is
      // consulted only to confirm liveness, and an unknowable answer
      // degrades to trusting the registry. Stopped principals are always
      // excluded, regardless of what mngr reports.
      const live = await liveIds();
      return registry
        .list()
        .filter((r) => r.backend === "mngr" && r.status !== "stopped")
        .map((r) => ({ agentId: r.agentId, nativeId: r.nativeId, backend: "mngr" as const }))
        .filter((r) => live === null || r.nativeId === null || live.has(r.nativeId));
    },

    async stop(ref) {
      if (ref.nativeId) await exec(argvStop(ref.nativeId));
      registry.markStopped(ref.agentId);
    },

    async transcript(ref) {
      return ref.nativeId ? fetchTranscript(ref.nativeId) : null;
    },
  };
}
