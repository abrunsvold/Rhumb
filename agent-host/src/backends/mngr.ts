import type { TranscriptMessage } from "../types.js";
import type { AgentBackend, AgentRef, AgentSpec } from "./types.js";
import type { AgentRegistry } from "../agents.js";
import { PROVIDER_CREDENTIAL_VARS } from "../provider.js";
import { STRIPPED_ENV_VARS } from "../env.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Invokes the mngr CLI. `opts.env`, when provided, is the credential
 *  overlay this backend wants layered onto the child process's environment —
 *  it is NOT a complete environment. A real implementation (Task 5) MUST
 *  MERGE `opts.env` over its own base environment (at minimum inheriting
 *  `PATH`/`HOME`, since `mngr` itself shells out to `git`/`tmux`/`jq` and
 *  needs to find them and the user's config); it must never REPLACE the
 *  child's environment with `opts.env` alone, or `mngr` cannot run at all.
 *
 *  Note that the credential guarantee this backend provides does NOT depend
 *  on `opts.env` — it comes from the explicit `--env` flags baked into
 *  argvCreate's argv (see credentialEnvFlags), which override whatever the
 *  mngr tmux server was started with regardless of how `opts.env` is
 *  implemented (docs/dogfood/2026-08-03-mngr-phase0.md, Q2). `opts.env` is
 *  passed through here only so a future exec implementation has the
 *  selected credentials on hand if the `mngr` process itself needs them
 *  (e.g. to reach a remote host) — it is not a security boundary. */
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
 *  entirely, so the only verified remedy is an explicit `--env` for every
 *  variable that must never be inherited ambiently.
 *
 *  The guarantee this function actually provides: every entry in
 *  PROVIDER_CREDENTIAL_VARS (provider.ts) is set to exactly the selected
 *  provider's value, or blanked; and every entry in STRIPPED_ENV_VARS
 *  (env.ts) is unconditionally blanked. Together that reproduces
 *  `sanitizedEnv`'s two static passes across the mngr boundary.
 *
 *  What it does NOT reproduce: `sanitizedEnv`'s third pass, which strips
 *  every `RHUMB_*` var by enumerating `process.env` dynamically. This
 *  function only knows two fixed variable lists — it has no access to the
 *  ambient environment of whatever process starts (or already started) the
 *  tmux server, so it cannot discover `RHUMB_*` vars to blank them. If an
 *  ambient `RHUMB_*` secret (e.g. the scoped Proxmox token, the PG admin
 *  connection string) is present on the tmux server's environment, it is NOT
 *  blanked here and would reach the agent. Closing that gap requires
 *  enumerating the real environment at the exec seam, which is Task 5's
 *  responsibility, not this backend's. */
function credentialEnvFlags(credentialEnv: Record<string, string>): string[] {
  const flags: string[] = [];
  for (const key of PROVIDER_CREDENTIAL_VARS) {
    const value = credentialEnv[key];
    flags.push("--env", `${key}=${value ?? ""}`);
  }
  for (const key of STRIPPED_ENV_VARS) {
    flags.push("--env", `${key}=`);
  }
  return flags;
}

/** Conservative allowlist for the name mngr create's argv position 1. Names
 *  come from AgentRecord.name, which this backend does not control the
 *  origin of. Without this check a name shaped like a flag (e.g.
 *  `--env=ANTHROPIC_BASE_URL=https://attacker.example`) would sit, unquoted,
 *  directly ahead of the credential `--env` flags this task exists to
 *  control, and mngr's own argument parser — not a shell, but still a
 *  parser — could read it as one. */
const VALID_MNGR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Maps one line of `mngr transcript --format jsonl` output to a
 *  TranscriptMessage. mngr's transcript is agent-agnostic and may carry
 *  event types Rhumb has no use for, so unrecognised types — and
 *  unparseable lines, and lines whose expected text field isn't a string —
 *  are skipped rather than thrown or coerced to an empty string. */
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
    return typeof e.content === "string" ? { kind: "user", text: e.content } : null;
  }
  if (e.type === "assistant_message") {
    return typeof e.text === "string" ? { kind: "text", text: e.text } : null;
  }
  return null;
}

/** The newest assistant reply that appeared strictly at or after `before`'s
 *  snapshot length, or `null` if none did. Two independent guards, both
 *  needed:
 *
 *  1. Transcript growth is a sound DELIVERY signal — mngr appends a
 *     `user_message` the moment a prompt is submitted — but it is NOT an
 *     ANSWER signal: the newest entry may well be the operator's own
 *     prompt, echoed back as a `user_message`, with no `assistant_message`
 *     behind it yet. Only a `kind: "text"` entry (mapped from
 *     `assistant_message`) is ever eligible to become a `result` event.
 *  2. Only entries at index >= `before`'s length count as "new". Without
 *     this, an agent with prior history could have its LAST turn's answer
 *     reported as THIS turn's answer whenever the fresh reply hasn't
 *     streamed into the transcript by the time `after` is read — the same
 *     stale-reply failure mode as the non-zero-exit reconciliation path,
 *     just reachable on the plain `code === 0` success path too.
 *
 *  If `before` itself is untrustworthy (`null` — the pre-send transcript
 *  read failed), there is no baseline to measure "new" against, so this
 *  conservatively returns `null` rather than guessing every entry in
 *  `after` is new. */
function newAssistantReply(
  before: TranscriptMessage[] | null,
  after: TranscriptMessage[] | null,
): TranscriptMessage | null {
  if (!after || before === null) return null;
  for (let i = after.length - 1; i >= before.length; i--) {
    if (after[i].kind === "text") return after[i];
  }
  return null;
}

/** Why `ensureAgent` left a principal unbound (`nativeId: null`), so
 *  `send()` can report something more accurate than one generic message for
 *  four different situations (see `ensureFailureMessage`). Not part of the
 *  public `AgentRef` contract — `EnsureResult` is a superset used only
 *  inside this module. */
type EnsureFailureReason = "stopped" | "invalid-name" | "create-failed" | "unresolved";

interface EnsureResult extends AgentRef {
  reason?: EnsureFailureReason;
}

function ensureFailureMessage(reason: EnsureFailureReason | undefined): string {
  switch (reason) {
    case "stopped":
      return "mngr: this principal was stopped and must not be silently resumed; a new agentId is required to continue";
    case "invalid-name":
      return "mngr: agent name is not valid for `mngr create`, refused before invoking the CLI";
    case "unresolved":
      return "mngr: an agent may have just been created but its id could not be confirmed yet; it will be adopted on a later turn once list() is trustworthy again";
    case "create-failed":
    default:
      return "mngr: could not create an agent for this principal";
  }
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

  /** Parsed `mngr list --format json` agents, or `null` when the listing
   *  cannot be trusted (non-zero exit, or output that doesn't match the
   *  verified `{"agents":[...]}` shape — in particular a bare array, which
   *  an earlier draft of this backend mistakenly treated as valid). `null`
   *  means "unknowable", never "empty". */
  async function listAgents(): Promise<Array<{ id?: string; name?: string }> | null> {
    const res = await exec(argvList());
    if (res.code !== 0) return null;
    try {
      const parsed = JSON.parse(res.stdout) as { agents?: Array<{ id?: string; name?: string }> };
      if (!parsed || !Array.isArray(parsed.agents)) return null;
      return parsed.agents;
    } catch {
      return null;
    }
  }

  /** Live mngr agent ids, or `null` when liveness is unknowable. `null`
   *  means "do not conclude anything" — never "nothing is alive". */
  async function liveIds(): Promise<Set<string> | null> {
    const agents = await listAgents();
    if (agents === null) return null;
    const ids = new Set<string>();
    for (const a of agents) if (a?.id) ids.add(a.id);
    return ids;
  }

  /** Resolves the mngr id of an agent by matching on its `name`, rather
   *  than trusting `create`'s stdout. docs/dogfood/2026-08-03-mngr-phase0.md
   *  records that mngr's stdout can carry provider banners and is "not safe
   *  to parse without --format json"; `create`'s stdout was never
   *  separately characterised as safe. Trusting it risks binding a banner
   *  (or any other stray stdout) as the nativeId, which would never match a
   *  real id in `liveIds()` and cause `ensure()` to conclude "provably
   *  dead" and re-create on every subsequent turn.
   *
   *  Returns a DISCRIMINATED result rather than collapsing to `string |
   *  null`, on purpose: "no agent with this name exists" (KNOWN ABSENT) and
   *  "the listing itself could not be trusted" (UNKNOWABLE, non-zero exit
   *  or unparseable output) are different facts and must not be conflated —
   *  the same "null means unknowable, never empty" discipline `listAgents`/
   *  `liveIds` already follow. Conflating them here was the N1 defect: a
   *  transient listing failure right after a successful `create` would read
   *  as "no such agent" and the caller would give up on a principal whose
   *  mngr agent actually exists. Callers decide what UNKNOWABLE means for
   *  them (see the "unresolved" reason in `ensureAgent`, which deliberately
   *  does NOT report a failed create).
   *
   *  Name collisions with a pre-existing, unrelated agent are a known,
   *  accepted limitation (first match wins) — mngr is assumed to enforce
   *  name uniqueness. */
  async function resolveNativeIdByName(
    name: string,
  ): Promise<{ status: "found"; id: string } | { status: "not-found" } | { status: "unknowable" }> {
    const agents = await listAgents();
    if (agents === null) return { status: "unknowable" };
    const match = agents.find((a) => a?.name === name);
    return match?.id ? { status: "found", id: match.id } : { status: "not-found" };
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

  async function ensureAgent(agentId: string): Promise<EnsureResult> {
    const existing = registry.get(agentId);

    if (existing?.status === "stopped") {
      // A stopped principal must not be silently revived. Two reasons this
      // is a refusal rather than "spawn a replacement":
      //  1. `mngr stop` (unlike `mngr destroy`) may only detach the agent
      //     rather than tear it down, so the old nativeId can still appear
      //     in `mngr list` — reusing it here would resurrect a principal
      //     Rhumb was explicitly told to retire, and it would be invisible
      //     via list() forever after, since list() always excludes
      //     status:"stopped" records.
      //  2. Spawning a fresh replacement doesn't fix that either: bind()
      //     only updates nativeId/lastActiveAt, never status (agents.ts has
      //     no API to flip a record back to "active"), so the new agent
      //     would ALSO stay permanently excluded from list() — and because
      //     this branch would fire again on every subsequent call, it would
      //     spawn a brand new agent on every single ensure(), which is
      //     exactly the duplicate-spawn bug the liveness rule exists to
      //     prevent, just triggered by status instead of liveness.
      // A stopped principal is therefore a dead end by design: send() will
      // report this via a "stopped" error, distinct from a create failure.
      // Reviving one requires a new agentId, minted by the caller.
      return { agentId, nativeId: null, backend: "mngr", reason: "stopped" };
    }

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
    if (!VALID_MNGR_NAME.test(name)) {
      // Fail closed rather than hand an unsafe name to `create`.
      return { agentId, nativeId: null, backend: "mngr", reason: "invalid-name" };
    }

    // Resolve-BEFORE-create: adopt a pre-existing agent under this name
    // instead of unconditionally calling `create`. This is what actually
    // fixes the N1 orphan path, not just the discriminated result type
    // above: if a PRIOR ensure() call's `create` succeeded but the
    // immediately-following resolveNativeIdByName was UNKNOWABLE (leaving
    // the principal unbound, see below), this step is where that agent
    // gets adopted on a LATER call — instead of calling `create` again,
    // which Phase 0 documents fails once the branch `mngr/<name>` already
    // exists (permanently orphaning the agent if retried blindly). It also
    // makes `ensureAgent` idempotent under concurrent/repeated calls in
    // general, not just in the recovery case.
    const preexisting = await resolveNativeIdByName(name);
    if (preexisting.status === "found") {
      registry.bind(agentId, preexisting.id);
      return { agentId, nativeId: preexisting.id, backend: "mngr" };
    }

    const res = await exec(argvCreate(name, credentialEnv), { env: credentialEnv });
    if (res.code !== 0) {
      // A genuine create failure (mngr's own exit code says so). Leave the
      // principal unbound; send() reports it as an error event rather than
      // throwing here.
      return { agentId, nativeId: null, backend: "mngr", reason: "create-failed" };
    }

    const resolved = await resolveNativeIdByName(name);
    if (resolved.status === "found") {
      registry.bind(agentId, resolved.id);
      return { agentId, nativeId: resolved.id, backend: "mngr" };
    }
    // Neither "found" branch fired: either UNKNOWABLE (the list lookup
    // itself failed) or "not-found" (create reported success but no agent
    // shows up under this name — unexpected, but not something we can
    // resolve here either). Deliberately NOT reported as "create-failed" in
    // either case: `create`'s own exit code already said it succeeded, and
    // concluding failure here is exactly the N1 defect. The principal stays
    // unbound for THIS call (there is no confirmed id to hand back), but
    // the resolve-before-create step above will pick this agent up on a
    // later call once `list` is trustworthy again (UNKNOWABLE case) or will
    // legitimately retry `create` (the "not-found" case, where nothing was
    // actually created under this name and a fresh attempt is correct).
    return { agentId, nativeId: null, backend: "mngr", reason: "unresolved" };
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
          onEvent({ type: "error", message: ensureFailureMessage(ensured.reason) });
          return { ...ref, nativeId: null };
        }
      }

      onEvent({ type: "session", sessionId: nativeId });

      // `mngr message` has been observed to exit non-zero on a message it
      // actually delivered (docs/dogfood/2026-08-03-mngr-phase0.md, Q1: a
      // 90s "timeout waiting for message submission signal" while the
      // transcript proved the turn was answered). A non-zero exit is
      // therefore NOT proof of non-delivery — reconcile against the
      // transcript before surfacing an error.
      //
      // "Delivered" requires BOTH snapshots to be trustworthy: if the
      // PRE-send read itself failed (`before === null`), a longer `after`
      // proves nothing — it may just be pre-existing history from an
      // earlier turn, and reporting that as the answer to THIS prompt would
      // be a stale reply presented as fresh (see the regression test for
      // this). Growth is also only a DELIVERY signal, not an ANSWER signal:
      // see newAssistantReply for why the reply text is never taken from
      // the newest transcript entry blindly, and never from an entry that
      // was already present in `before` (a PREVIOUS turn's reply, on the
      // plain success path below).
      const before = await fetchTranscript(nativeId);
      const res = await exec(argvSend(nativeId, prompt), { env: credentialEnv });
      const after = await fetchTranscript(nativeId);
      const delivered = before !== null && after !== null && after.length > before.length;
      const reply = newAssistantReply(before, after);

      if (res.code !== 0) {
        if (delivered) {
          if (reply) {
            // Delivered despite the non-zero exit, and a NEW assistant
            // reply is already present: report what the transcript
            // actually shows, not the CLI's exit code.
            registry.touch(ref.agentId);
            onEvent({ type: "result", result: reply.text, isError: false });
            return { ...ref, nativeId };
          }
          // The transcript grew (the prompt was submitted) but no NEW
          // assistant reply is present yet — the turn is not actually
          // answered. Do NOT synthesise a result from the operator's own
          // prompt (a `user_message` entry); report this honestly rather
          // than claiming success. Still touch(): submission was proven,
          // even though the answer wasn't.
          registry.touch(ref.agentId);
          onEvent({
            type: "error",
            message: `mngr: message delivered but not yet answered (${res.stderr.trim() || `exit ${res.code}`})`,
          });
          return { ...ref, nativeId };
        }
        onEvent({ type: "error", message: `mngr: ${res.stderr.trim() || `exit ${res.code}`}` });
        return { ...ref, nativeId };
      }

      registry.touch(ref.agentId);
      // Fallback note: if the transcript is unreadable, has no NEW
      // assistant entry yet, or `before` itself was unreadable, this falls
      // back to `mngr message`'s own stdout. Phase 0 never characterised
      // that stdout as carrying the assistant's reply — it may be empty, a
      // banner, or something else entirely — so this is a best-effort
      // fallback, not a verified contract.
      onEvent({ type: "result", result: reply?.text ?? res.stdout.trim(), isError: false });
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
      if (!ref.nativeId) {
        registry.markStopped(ref.agentId);
        return;
      }
      const res = await exec(argvStop(ref.nativeId));
      if (res.code !== 0) {
        // Do not claim stopped when the CLI call actually failed — doing so
        // would leave a live agent with no operator handle left to retry
        // from (list() would already have hidden it). Surface the failure
        // instead of swallowing it.
        throw new Error(`mngr: failed to stop ${ref.nativeId}: ${res.stderr.trim() || `exit ${res.code}`}`);
      }
      registry.markStopped(ref.agentId);
    },

    async transcript(ref) {
      return ref.nativeId ? fetchTranscript(ref.nativeId) : null;
    },
  };
}
