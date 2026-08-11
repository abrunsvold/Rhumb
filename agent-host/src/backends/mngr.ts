import { resolve as resolvePath } from "node:path";
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

/** Invokes the mngr CLI. `opts.env`, when provided, is meant as a credential
 *  overlay layered onto the child process's environment — it is NOT a
 *  complete environment. A real implementation MUST MERGE `opts.env` over
 *  its own base environment (at minimum inheriting `PATH`/`HOME`, since
 *  `mngr` itself shells out to `git`/`tmux`/`jq` and needs to find them and
 *  the user's config); it must never REPLACE the child's environment with
 *  `opts.env` alone, or `mngr` cannot run at all. `createRealExec` (exec.ts)
 *  implements this merge.
 *
 *  This module (mngr.ts) itself no longer PASSES `credentialEnv` via
 *  `opts.env` at any call site (fix round 1, I1) — the credential guarantee
 *  comes entirely from the explicit `--env` flags baked into argvCreate's
 *  argv (see credentialEnvFlags), which override whatever the mngr tmux
 *  server was started with regardless of `opts.env`
 *  (docs/dogfood/2026-08-03-mngr-phase0.md, Q2). The local `mngr` CLI process
 *  does not need the credential itself for the local provider, and handing
 *  it the raw value is actively harmful on the invocation that STARTS the
 *  tmux server: that value would sit in the daemon's own long-lived
 *  environment (readable via `tmux showenv`, inherited by any later
 *  non-Rhumb agent on that server) for as long as the server runs — far
 *  longer than the one `mngr` process it was meant for. `opts.env` therefore
 *  is NOT a general-purpose channel for secrets in this backend; it remains
 *  part of `ExecFn`'s contract only because some future call site (a remote
 *  host, a different provider) may legitimately need to hand `mngr` itself
 *  a value it cannot get any other way — evaluate that need in this module,
 *  where the tmux-server persistence risk above is visible, before adding a
 *  new `opts.env` call site. */
export type ExecFn = (
  argv: string[],
  opts?: { env?: Record<string, string> },
) => Promise<ExecResult>;

/** The mngr `--label` key this backend uses to mark an agent as belonging
 *  to a specific Rhumb principal. Verified against real mngr 0.2.17:
 *  `create` accepts repeatable `--label KEY=VALUE`, and `list --format
 *  json` round-trips it back as a `labels` object per agent (e.g.
 *  `{"labels":{"rhumb_agent_id":"rhumb-test-123"}}`). This is the ONLY key
 *  `resolveNativeIdByLabel` ever matches on — see its doc comment for why
 *  matching on `name` (the pre-A1 behaviour) was a security defect. */
const RHUMB_AGENT_ID_LABEL = "rhumb_agent_id";

// Command shapes verified against mngr 0.2.17 in
// docs/dogfood/2026-08-03-mngr-phase0.md. Adjust these builders — and
// nothing else — if the CLI surface changes.
const argvCreate = (
  name: string,
  agentId: string,
  credentialEnv: Record<string, string>,
  extraBlankedVars: readonly string[],
  spec: AgentSpec,
  lineage: { parentAgentId: string | null; depth: number },
): string[] => [
  "create",
  name,
  "claude",
  "--no-connect",
  "-y",
  "--label",
  `${RHUMB_AGENT_ID_LABEL}=${agentId}`,
  // Spawn lineage travels as mngr labels, not env: the RHUMB_* wildcard
  // blanking below (credentialEnvFlags) erases any RHUMB_* env var, so an
  // env-based channel would be silently destroyed. Labels round-trip
  // through `mngr list --format json` instead (verified against 0.2.17,
  // docs/dogfood/2026-08-03-mngr-phase0.md). `rhumb_parent_id` is omitted
  // entirely for a root agent rather than emitted empty, so a later audit
  // can distinguish "no parent" from "label missing".
  ...(lineage.parentAgentId ? ["--label", `rhumb_parent_id=${lineage.parentAgentId}`] : []),
  "--label",
  `rhumb_depth=${lineage.depth}`,
  ...workspaceFlags(spec.workspace),
  ...credentialEnvFlags(credentialEnv, extraBlankedVars),
  // Per `mngr create --help`: "Arguments after -- are passed directly to
  // the agent command" — see agentArgsFor's doc comment for what crosses
  // and what deliberately doesn't.
  "--",
  ...agentArgsFor(spec),
];
const argvSend = (nativeId: string, prompt: string): string[] => ["message", nativeId, "-m", prompt];
const argvStop = (nativeId: string): string[] => ["stop", nativeId];
const argvList = (): string[] => ["list", "--format", "json"];
const argvTranscript = (nativeId: string): string[] => ["transcript", nativeId, "--format", "jsonl"];

/** Makes the spawned agent actually operate on `AgentSpec.workspace` (C2).
 *
 *  Before this existed, `argvCreate` passed no source at all and
 *  `createRealExec` passed no `cwd`, so `mngr create --from` fell back to
 *  its documented default — "git root if omitted" — resolved from the
 *  agent-host process's CWD. On the deployment box the systemd unit sets
 *  `WorkingDirectory=<repo>/agent-host`, so that git root is **the Rhumb
 *  checkout itself**. Three separate consequences, all silent:
 *   1. the agent could not see `workspace/` at all — no data-sources, no
 *      surfaces, no ontology, none of the uploads `POST /files` writes;
 *   2. every principal left a `mngr/<name>` branch AND a git worktree
 *      inside the operator's own checkout, permanently (nothing calls
 *      `mngr destroy -b`, and nothing in `src/` calls `stop()`);
 *   3. `mngr create` defaults to `--ensure-clean`, so ANY uncommitted
 *      change in the checkout failed EVERY turn.
 *
 *  Verified against real mngr 0.2.17 (see the live suite's work_dir
 *  assertion, and the C2 probes recorded in the final fix report):
 *   - `--from :<PATH>` selects a DIRECTORY as the source (a bare name would
 *     mean another mngr AGENT — hence the mandatory `:` prefix).
 *   - `--transfer none` means "run in-place (no transfer)". This is the
 *     load-bearing flag: without it mngr's default for a git source is
 *     `git-worktree`, i.e. the agent would get a COPY on a fresh
 *     `mngr/<name>` branch and every write it made to `workspace/` would
 *     land somewhere the host never reads. Rhumb's workspace is shared
 *     mutable state, not a branch to fork.
 *   - `--no-ensure-clean` is required whenever the workspace happens to sit
 *     in a git repo: mngr aborts on a dirty tree even under
 *     `--transfer none`, which was confirmed empirically. For an in-place
 *     run there is nothing to transfer and no branch to cut, so a dirty
 *     tree is not a hazard — and `workspace/` is *expected* to be dirty
 *     (it is where agents write).
 *  Confirmed to work for BOTH a git and a non-git workspace, with
 *  `MNGR_AGENT_WORK_DIR` equal to the workspace and `initial_branch: null`
 *  in `mngr list --format json` (no branch, no worktree, nothing left
 *  behind in any repo).
 *
 *  The path is `resolve()`d because `RHUMB_WORKSPACE` defaults to the
 *  RELATIVE `./workspace`, and a relative `--from` would otherwise be
 *  interpreted against whatever CWD the agent-host process happens to have
 *  — reintroducing exactly the implicit-CWD dependency this fix removes. */
function workspaceFlags(workspace: string): string[] {
  return ["--from", `:${resolvePath(workspace)}`, "--transfer", "none", "--no-ensure-clean"];
}

/** Fail closed at construction rather than silently running the agent
 *  against the wrong tree (C2's fallback (b), kept as a guard even though
 *  (a) succeeded). A blank/whitespace workspace would `resolve()` to the
 *  process CWD, which on the deployment box is the Rhumb checkout — the
 *  precise failure this whole fix exists to eliminate — so it is refused by
 *  name instead of being papered over. */
function assertUsableWorkspace(workspace: unknown): void {
  if (typeof workspace !== "string" || workspace.trim() === "") {
    throw new Error(
      "RHUMB_AGENT_BACKEND=mngr requires a non-empty AgentSpec.workspace: it is passed to " +
        "`mngr create --from :<path> --transfer none` so the agent operates in-place on Rhumb's " +
        "workspace. Refusing to construct the mngr backend, because an empty workspace would " +
        "resolve to the agent-host process's current directory (the Rhumb checkout itself on a " +
        "systemd deployment) and the agent would silently run against the wrong tree.",
    );
  }
}

/** mngr does not scrub the ambient environment: the spawned agent's env
 *  comes from whatever the tmux server was started with, not from the env of
 *  the `mngr` process that requested it (docs/dogfood/2026-08-03-mngr-phase0.md,
 *  Q2). A pre-existing tmux server bypasses a clean child-process env
 *  entirely, so the only verified remedy is an explicit `--env` for every
 *  variable that must never be inherited ambiently.
 *
 *  The guarantee this function actually provides: every entry in
 *  PROVIDER_CREDENTIAL_VARS (provider.ts) is set to exactly the selected
 *  provider's value, or blanked; every entry in STRIPPED_ENV_VARS (env.ts)
 *  is unconditionally blanked; and every entry the caller passes in
 *  `extraBlankedVars` is ALSO blanked, deduplicated against the two static
 *  lists so no variable is ever emitted twice. Together that reproduces all
 *  three of `sanitizedEnv`'s passes across the mngr boundary.
 *
 *  `extraBlankedVars` exists because `sanitizedEnv`'s third pass — strip
 *  every `RHUMB_*` var — is a wildcard, not a fixed list, and this module
 *  has no access to the ambient environment of whatever process starts (or
 *  already started) the tmux server; it only knows the two static lists
 *  above. `src/index.ts` NARROWS that gap (does not close it — see below):
 *  it computes the `RHUMB_*` keys of ITS OWN `process.env` (the agent-host
 *  process) at the exec seam and passes them in here.
 *
 *  That is a weaker guarantee than `sanitizedEnv`'s, and worth stating
 *  precisely: this blanks the `RHUMB_*` vars the agent-host PROCESS
 *  happens to carry right now, not necessarily every `RHUMB_*` var the
 *  mngr tmux SERVER's own environment actually holds — the two can differ
 *  whenever the tmux server predates the current agent-host process's
 *  environment (e.g. it survived a restart of the host process with a
 *  changed `RHUMB_*` var, or a human started it directly). Phase 0 hit
 *  exactly this asymmetry testing ambient credential leakage: a
 *  pre-existing tmux server silently made a leakage test measure nothing
 *  until `tmux kill-server` cleared it first
 *  (docs/dogfood/2026-08-03-mngr-phase0.md, Q2). Operational consequence:
 *  an operator who changes which `RHUMB_*` vars are set and needs that
 *  change to reach mngr-spawned agents must kill the mngr tmux server so
 *  it restarts under the new environment — restarting the agent-host
 *  process alone is not sufficient if the tmux server survives it. Logged
 *  as a known gap for final review (I2), not fixed here: closing it fully
 *  would mean reading the tmux server's OWN environment (e.g. via `tmux
 *  showenv -g`) rather than this process's, which is a larger change than
 *  this parameter's scope.
 *
 *  Within that scope, `extraBlankedVars` is still purely additive — when a
 *  caller omits it, behaviour (including the exact `--env` flag count) is
 *  unchanged from before this parameter existed. */
function credentialEnvFlags(
  credentialEnv: Record<string, string>,
  extraBlankedVars: readonly string[] = [],
): string[] {
  const flags: string[] = [];
  const emitted = new Set<string>();
  for (const key of PROVIDER_CREDENTIAL_VARS) {
    const value = credentialEnv[key];
    flags.push("--env", `${key}=${value ?? ""}`);
    emitted.add(key);
  }
  for (const key of STRIPPED_ENV_VARS) {
    flags.push("--env", `${key}=`);
    emitted.add(key);
  }
  for (const key of extraBlankedVars) {
    if (emitted.has(key)) continue;
    flags.push("--env", `${key}=`);
    emitted.add(key);
  }
  return flags;
}

/** Agent CLI args that DO have a `claude` CLI equivalent and can therefore
 *  cross the mngr boundary via `mngr create ... -- <agent args>` (fix
 *  round 1, I7). Verified directly against the flags the bundled CLI
 *  defines (`node_modules/@anthropic-ai/claude-agent-sdk/cli.js`):
 *  `--model <model>`, `--permission-mode <mode>` (same choices as
 *  VALID_PERMISSION_MODES in config.ts), `--allowedTools/--allowed-tools
 *  <tools...>` ("Comma or space-separated list of tool names"),
 *  `--disallowedTools/--disallowed-tools <tools...>` (same), and
 *  `--append-system-prompt <prompt>`.
 *
 *  What deliberately does NOT appear here: `spec.extraOptions.mcpServers`
 *  and `spec.extraOptions.canUseTool`. Both are in-process JS with no CLI
 *  equivalent — live `createSdkMcpServer(...)` objects closing over
 *  `PendingActions` / the Proxmox client / pg-admin
 *  (src/infra/server.ts:81, src/ontology/server.ts:9), and an async
 *  callback awaiting an in-memory operator-approval promise
 *  (src/infra/server.ts:22). The CLI's `--mcp-config` only loads EXTERNAL
 *  servers from a JSON file; there is no way to hand it a live JS closure.
 *  `warnAboutUncarriableSpec` warns, once at construction, when either is
 *  present rather than silently dropping them here — see its doc comment
 *  for why running WITHOUT them is a capability reduction rather than a
 *  gate bypass, and so a warning rather than a refusal (fix round 2). */
function agentArgsFor(spec: AgentSpec): string[] {
  const args: string[] = ["--model", spec.model, "--permission-mode", spec.permissionMode];
  const extra = spec.extraOptions ?? {};

  const allowedTools = asStringList(extra.allowedTools);
  if (allowedTools.length > 0) args.push("--allowedTools", allowedTools.join(","));

  const disallowedTools = asStringList(extra.disallowedTools);
  if (disallowedTools.length > 0) args.push("--disallowedTools", disallowedTools.join(","));

  const append = asSystemPromptAppend(extra.systemPrompt);
  if (append) args.push("--append-system-prompt", append);

  return args;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** `spec.extraOptions.systemPrompt` is `{ type: "preset", preset: "...",
 *  append: "..." }` (see src/index.ts's sessionExtraOptions) when present.
 *  Only the `append` string has a CLI equivalent (`--append-system-prompt`
 *  appends to the CLI's OWN default preset, which is the closest available
 *  match); the preset selector itself isn't user-configurable via a flag,
 *  so it is intentionally not inspected here. */
function asSystemPromptAppend(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const append = (value as { append?: unknown }).append;
  return typeof append === "string" && append.length > 0 ? append : null;
}

/** Warns, once at construction, when `spec.extraOptions` carries something
 *  that cannot cross the mngr CLI boundary (see `agentArgsFor`'s doc
 *  comment for exactly what and why) — MCP servers and the `canUseTool`
 *  approval callback. Checked once, synchronously, at construction, so the
 *  warning lands at BOOT next to the other startup lines
 *  (`assertMngrPrerequisites`, exec.ts; `warnIfClientCertVarsPresent`,
 *  index.ts) rather than repeating on every turn. Fix round 1 made this a
 *  hard refusal; fix round 2 corrected that — see below.
 *
 *  **Why a warning, not a refusal (the fix round 2 correction):** dropping
 *  these does NOT produce an ungated agent — it produces a strictly LESS
 *  CAPABLE one, and the two are not the same failure mode:
 *   - `makeCanUseTool` (src/infra/server.ts) only gates tool NAMES in
 *     `GATED_TOOL_NAMES`, i.e. `mcp__infra__*`; every other tool it allows
 *     unconditionally. Those gated tools are SERVED BY the infra MCP
 *     server. If that server cannot cross to the mngr agent, the agent has
 *     no such tools to call in the first place, so there is nothing left
 *     for `canUseTool` to gate — dropping it alongside the server it
 *     protects removes a capability, not a check on one that's still
 *     present.
 *   - Proxmox/Postgres credentials cannot leak around the missing MCP
 *     server either: the `RHUMB_*` wildcard blanking (`extraBlankedVars`,
 *     `credentialEnvFlags`) covers `RHUMB_PROXMOX_*` and friends, so a
 *     mngr agent cannot reach infra through Bash as a substitute.
 *   - Bash/file permissions reach parity through `--permission-mode`
 *     (`agentArgsFor`), which DOES cross the boundary.
 *  Net effect: a mngr agent has strictly FEWER capabilities than an SDK
 *  agent given the same `spec` — never the SAME capabilities behind a
 *  weaker (or absent) gate. Refusing to boot over a capability REDUCTION
 *  was too strong; the operator needs to know about it, not be blocked by
 *  it, so this warns instead — loudly, naming exactly what is dropped,
 *  never silently. */
function warnAboutUncarriableSpec(spec: AgentSpec): void {
  const extra = spec.extraOptions ?? {};
  const mcpServers = extra.mcpServers;
  const mcpServerNames =
    mcpServers && typeof mcpServers === "object" ? Object.keys(mcpServers as object) : [];
  const hasCanUseTool = extra.canUseTool !== undefined;

  if (mcpServerNames.length === 0 && !hasCanUseTool) return;

  const parts: string[] = [];
  if (mcpServerNames.length > 0) {
    parts.push(`the in-process MCP server(s) (${mcpServerNames.join(", ")}), and every tool they provide,`);
  }
  if (hasCanUseTool) {
    // Deliberately NOT phrased as "ungated" — the gated tools this callback
    // protects are themselves unreachable from a mngr agent (see the doc
    // comment above), so there is nothing left to gate, not a gate left
    // open.
    parts.push(
      "the operator-approval gate (canUseTool), which is moot here rather than bypassed, since " +
        "the infra tools it protects are unreachable, not merely ungated,",
    );
  }
  console.warn(
    `[rhumb] WARNING: RHUMB_AGENT_BACKEND=mngr cannot carry ${parts.join(" or ")} across the mngr ` +
      "CLI boundary (--mcp-config only loads external servers from JSON; there is no CLI " +
      "equivalent for an in-process approval callback). This mngr agent will run WITHOUT them — " +
      "strictly fewer capabilities than the SDK path would have for the same spec, never the " +
      "same capabilities with a weaker gate.",
  );
}

/** Conservative allowlist for the name mngr create's argv position 1. Names
 *  come from AgentRecord.name, which this backend does not control the
 *  origin of. Without this check a name shaped like a flag (e.g.
 *  `--env=ANTHROPIC_BASE_URL=https://attacker.example`) would sit, unquoted,
 *  directly ahead of the credential `--env` flags this task exists to
 *  control, and mngr's own argument parser — not a shell, but still a
 *  parser — could read it as one. */
const VALID_MNGR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A parsed mngr transcript event. Extends the public TranscriptMessage with
 *  the terminal-ness signal Rhumb needs internally; `transcript()` strips it
 *  before returning, so the public shape (mirrored in client/) is unchanged. */
export interface TranscriptEntry extends TranscriptMessage {
  finishReason: string | null;
}

/** Reasons that mean "the model is done with this turn".
 *
 *  These are Claude's own Messages API `stop_reason` values, passed through
 *  VERBATIM by mngr as `finish_reason` — confirmed by reading mngr's own
 *  source (`~/.local/share/uv/tools/imbue-mngr/lib/python3.12/site-packages/
 *  imbue/mngr_claude/resources/common_transcript_convert.py:154,217`:
 *  `stop_reason = message.get("stop_reason")` then
 *  `"finish_reason": stop_reason`). That means the full value space is
 *  Claude's, not mngr's own vocabulary: `end_turn`, `tool_use`,
 *  `max_tokens`, `stop_sequence`, and `null` are all reachable.
 *
 *  `"stop_sequence"` is observed live in docs/dogfood/2026-08-03-mngr-phase0.md;
 *  `"end_turn"` is the ordinary "model finished talking" reason. Both are
 *  terminal. `"max_tokens"` is ALSO terminal — a token-truncated answer is
 *  still a finished turn (the model has stopped and will not add more);
 *  treating it as non-terminal would poll for the rest of `replyTimeoutMs`
 *  and then report "delivered but not yet answered" while a real, if
 *  truncated, answer already sits in the transcript — the exact
 *  hang-and-lose-the-answer failure this module exists to prevent, just via
 *  a different reason string.
 *
 *  `"tool_use"` is DELIBERATELY excluded: it marks a segment that ends in a
 *  tool call, i.e. the model is not done — exactly the narration-then-
 *  tool-then-answer shape this task exists to see through.
 *
 *  Anything ELSE — including `null` and any reason string we have not seen
 *  — is deliberately NON-terminal: treating an unrecognised reason as
 *  terminal would reintroduce the bug this exists to fix, for any reason
 *  string Claude's API adds in the future. */
export const TERMINAL_FINISH_REASONS: ReadonlySet<string> = new Set([
  "stop_sequence",
  "end_turn",
  "max_tokens",
]);

export function isTerminalFinishReason(reason: string | null): boolean {
  return reason !== null && TERMINAL_FINISH_REASONS.has(reason);
}

/** Emitted when a turn completes with a terminal reason but no text. Distinct
 *  from a real answer AND from a timeout — with a fleet, "finished with nothing
 *  to say" and "still working" must not look alike. */
export const EMPTY_COMPLETION_RESULT = "(agent completed with no output)";

/** The text to report for a terminal reply: the reply's own text, or
 *  `EMPTY_COMPLETION_RESULT` if the model produced nothing. Shared by both
 *  `send()` result-emission sites so they cannot drift apart. */
function resultTextFor(reply: TranscriptEntry): string {
  return reply.text.trim().length > 0 ? reply.text : EMPTY_COMPLETION_RESULT;
}

/** Maps one line of `mngr transcript --format jsonl` output to a
 *  TranscriptEntry. mngr's transcript is agent-agnostic and may carry
 *  event types Rhumb has no use for, so unrecognised types — and
 *  unparseable lines, and lines whose expected text field isn't a string —
 *  are skipped rather than thrown or coerced to an empty string. */
function parseTranscriptLine(line: string): TranscriptEntry | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  const finishReason = typeof e.finish_reason === "string" ? e.finish_reason : null;
  if (e.type === "user_message") {
    return typeof e.content === "string" ? { kind: "user", text: e.content, finishReason } : null;
  }
  if (e.type === "assistant_message") {
    return typeof e.text === "string" ? { kind: "text", text: e.text, finishReason } : null;
  }
  return null;
}

/** True only for mngr's specific "this agent has not produced any
 *  transcript events yet" error — the one non-zero `mngr transcript` exit
 *  that means EMPTY rather than UNREADABLE. See `fetchTranscript` for why
 *  the distinction matters and why this match is kept narrow. */
function isNoTranscriptYetError(stdout: string): boolean {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const e = event as Record<string, unknown>;
    if (e.event === "error" && typeof e.message === "string" && /no common transcript found/i.test(e.message)) {
      return true;
    }
  }
  return false;
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
 *  `after` is new.
 *
 *  3. Only a TERMINAL entry (`isTerminalFinishReason`) is eligible. A
 *     tool-using turn emits narration, then a tool call, then its real
 *     answer, each as a separate `assistant_message`; without this, `send()`
 *     would return on the FIRST new text entry — the narration — and declare
 *     the turn complete while the model is still working. An unrecognised
 *     `finish_reason` (including none at all) is deliberately treated as
 *     NON-terminal: see `isTerminalFinishReason`. */
function newAssistantReply(
  before: TranscriptEntry[] | null,
  after: TranscriptEntry[] | null,
): TranscriptEntry | null {
  if (!after || before === null) return null;
  for (let i = after.length - 1; i >= before.length; i--) {
    const entry = after[i];
    if (entry.kind === "text" && isTerminalFinishReason(entry.finishReason)) return entry;
  }
  return null;
}

/** How long `send()` waits for the model's reply to appear in the
 *  transcript after `mngr message` reports a successful SUBMISSION (C1).
 *  Sized against the same real-world behaviour `EXEC_TIMEOUT_MS` (exec.ts)
 *  is sized against: Phase 0 documented `mngr message` itself sitting for
 *  90s before returning, and a real Claude Code turn (tool calls, file
 *  edits) routinely runs minutes. Five minutes is long enough that a
 *  genuine turn is not truncated, and short enough that a wedged agent
 *  still resolves the operator's SSE stream with an honest
 *  "delivered but not yet answered" rather than hanging forever. */
const DEFAULT_REPLY_TIMEOUT_MS = 300_000;

/** Gap between transcript polls while waiting for that reply. Each poll is
 *  one `mngr transcript --format jsonl` process spawn, so this trades
 *  latency-to-first-answer against how hard the loop hammers the CLI; 2s
 *  keeps a fast turn feeling immediate at ~150 spawns worst case. */
const DEFAULT_REPLY_POLL_INTERVAL_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Why `ensureAgent` left a principal unbound (`nativeId: null`), so
 *  `send()` can report something more accurate than one generic message for
 *  the many situations that can lead there (see `ensureFailureMessage`).
 *  Not part of the public `AgentRef` contract — `EnsureResult` is a
 *  superset used only inside this module. */
type EnsureFailureReason =
  | "stopped"
  | "invalid-name"
  | "create-failed"
  | "create-unconfirmed"
  | "create-not-found"
  | "bound-elsewhere"
  | "bind-failed";

interface EnsureResult extends AgentRef {
  reason?: EnsureFailureReason;
}

function ensureFailureMessage(reason: EnsureFailureReason | undefined): string {
  switch (reason) {
    case "stopped":
      return "mngr: this principal was stopped and must not be silently resumed; a new agentId is required to continue";
    case "invalid-name":
      return "mngr: agent name is not valid for `mngr create`, refused before invoking the CLI";
    case "bound-elsewhere":
      return "mngr: this mngr agent is already bound to a different Rhumb principal; refusing to share it";
    case "bind-failed":
      // I4: `registry.bind` returns false when no record exists for this
      // agentId. Reporting a successful ensure in that case would hand back
      // a ref asserting a binding that was never persisted — the agentId ->
      // nativeId trust link is the ONE thing this module owns, so a bind
      // that did not happen must never be reported as one that did.
      return "mngr: a mngr agent exists for this principal but the agentId->nativeId binding could not be persisted (no such agent record in the registry); refusing to report an unbound principal as bound";
    case "create-unconfirmed":
      // The listing itself was unknowable (non-zero exit / unparseable),
      // NOT proof the agent doesn't exist — distinct from "create-not-found"
      // below (A2: these were wrongly collapsed into one "unresolved"
      // message that falsely implied a listing-trust problem even when the
      // listing was perfectly trustworthy and simply empty).
      return "mngr: an agent was likely just created but its id could not be confirmed yet (the listing itself was unavailable); it will be adopted on a later turn once list() is trustworthy again";
    case "create-not-found":
      // The listing WAS trustworthy (well-formed, zero exit) and simply
      // showed no agent under the expected label. Unexpected, but not a
      // listing problem — say so, rather than reusing the "unavailable
      // listing" wording above.
      return "mngr: create reported success but no agent with the expected label was found in a trustworthy listing; this will be retried on a later turn";
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
  /** Additional variable names to blank via `--env VAR=` on `create`,
   *  appended to (and deduplicated against) the PROVIDER_CREDENTIAL_VARS /
   *  STRIPPED_ENV_VARS blanking — see `credentialEnvFlags`. Optional and
   *  purely additive: omitting it reproduces today's behaviour exactly.
   *  `src/index.ts` passes the `RHUMB_*` keys of ITS OWN `process.env`
   *  here — the agent-host process's environment, not necessarily the
   *  mngr tmux server's (they can differ; see `credentialEnvFlags`'s doc
   *  comment, I2, for the asymmetry and the `tmux kill-server` operator
   *  requirement it implies). */
  extraBlankedVars?: readonly string[];
  /** How long `send()` waits for a NEW assistant reply to appear in the
   *  transcript after a successful `mngr message` submission (C1). `mngr
   *  message` returns on SUBMISSION, not completion — there is no
   *  wait-for-reply flag — so without this the operator's turn would
   *  complete before the model had answered. Injectable purely so unit
   *  tests can drive the loop without real sleeps; production uses the
   *  default. `0` means "read the transcript once, then give up", which is
   *  exactly the pre-C1 call pattern minus the dishonest fallback. */
  replyTimeoutMs?: number;
  /** Delay between transcript polls while waiting for that reply (C1). */
  replyPollIntervalMs?: number;
}): AgentBackend {
  const {
    exec,
    registry,
    credentialEnv,
    extraBlankedVars = [],
    spec,
    replyTimeoutMs = DEFAULT_REPLY_TIMEOUT_MS,
    replyPollIntervalMs = DEFAULT_REPLY_POLL_INTERVAL_MS,
  } = deps;
  assertUsableWorkspace(spec?.workspace);
  warnAboutUncarriableSpec(spec);

  /** Parsed `mngr list --format json` agents, or `null` when the listing
   *  cannot be trusted (non-zero exit, or output that doesn't match the
   *  verified `{"agents":[...]}` shape — in particular a bare array, which
   *  an earlier draft of this backend mistakenly treated as valid). `null`
   *  means "unknowable", never "empty". */
  async function listAgents(): Promise<
    Array<{ id?: string; name?: string; labels?: Record<string, unknown> }> | null
  > {
    const res = await exec(argvList());
    if (res.code !== 0) return null;
    try {
      const parsed = JSON.parse(res.stdout) as {
        agents?: Array<{ id?: string; name?: string; labels?: Record<string, unknown> }>;
      };
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

  /** Resolves the mngr id of an agent by matching on the
   *  `RHUMB_AGENT_ID_LABEL` label this backend stamps every agent it
   *  creates with (see `argvCreate`), rather than trusting `create`'s
   *  stdout OR matching on `name`.
   *
   *  Matching on `name` (this function's pre-A1 behaviour) was a security
   *  defect, not just a correctness one:
   *   1. `AgentRecord.name` has no uniqueness constraint and `bind()`
   *      doesn't check whether a nativeId is already claimed elsewhere, so
   *      two Rhumb principals sharing a display name could both resolve to
   *      — and both act on — the SAME mngr agent. That breaks the 1:1
   *      agentId<->nativeId binding this whole module exists to protect
   *      (one principal's prompts landing in another's transcript; `stop()`
   *      on one tearing down the other's agent).
   *   2. It was fail-OPEN: any agent under a matching name got adopted,
   *      including one a human ran `mngr create <name> claude` for
   *      directly, or one made by another tool — neither of which ever
   *      went through `argvCreate`'s `--env` credential scrub (the entire
   *      Q2 security guarantee this module exists to provide). Before
   *      resolve-before-create existed, a name collision instead drove an
   *      unconditional `create`, which mngr fails on the pre-existing
   *      `mngr/<name>` branch — i.e. it failed CLOSED. Adoption-by-name
   *      flipped that posture to fail-open, silently.
   *
   *  A label Rhumb itself stamps at creation time — checked for an EXACT
   *  match against the calling principal's own `agentId` — has neither
   *  problem: only an agent Rhumb created (and therefore already scrubbed)
   *  can ever satisfy the match, and the match is scoped to exactly the one
   *  principal asking.
   *
   *  Still returns a DISCRIMINATED result rather than collapsing to
   *  `string | null`: "no agent carries this label" (KNOWN ABSENT) and "the
   *  listing itself could not be trusted" (UNKNOWABLE, non-zero exit or
   *  unparseable output) are different facts and must not be conflated —
   *  the same "null means unknowable, never empty" discipline `listAgents`/
   *  `liveIds` already follow (this discrimination is unchanged by A1; only
   *  the match key changed). See the two `create-*` reasons in
   *  `ensureFailureMessage` for how callers use each case. */
  async function resolveNativeIdByLabel(
    agentId: string,
  ): Promise<{ status: "found"; id: string } | { status: "not-found" } | { status: "unknowable" }> {
    const agents = await listAgents();
    if (agents === null) return { status: "unknowable" };
    const match = agents.find((a) => a?.labels?.[RHUMB_AGENT_ID_LABEL] === agentId);
    return match?.id ? { status: "found", id: match.id } : { status: "not-found" };
  }

  /** Binds `nativeId` to `agentId`, unless that nativeId is already bound
   *  to a DIFFERENT, non-stopped registry record — belt-and-braces guard
   *  against a corrupted or colliding label (see A1). Adoption-by-label is
   *  meant to be 1:1 by construction, but nothing on mngr's side enforces
   *  that, and a silent cross-principal bind is exactly the trust violation
   *  this whole module exists to prevent, so this fails closed rather than
   *  trusting the label match alone. */
  function bindIfUnclaimed(agentId: string, nativeId: string): EnsureResult {
    const conflict = registry
      .list()
      .find((r) => r.nativeId === nativeId && r.agentId !== agentId && r.status !== "stopped");
    if (conflict) {
      return { agentId, nativeId: null, backend: "mngr", reason: "bound-elsewhere" };
    }
    // I4: `bind` returns false when the registry has no record for this
    // agentId — reachable through the public interface, since `ensure()`
    // accepts any agentId string and a caller can hand it one that was
    // never `create`d (the conformance suite's failing-backend fixture does
    // exactly that). Before this check, that path created a REAL mngr
    // agent, silently failed to persist the binding, and still returned a
    // ref asserting it — the one trust link this module owns, reported as
    // established when it was not.
    if (!registry.bind(agentId, nativeId)) {
      return { agentId, nativeId: null, backend: "mngr", reason: "bind-failed" };
    }
    return { agentId, nativeId, backend: "mngr" };
  }

  /** `registry.touch` returns false when no record exists for this agentId
   *  (I4). Not fatal — a touch only advances `lastActiveAt` — but it means
   *  the principal this turn ran for is absent from the registry, which
   *  every other invariant here depends on, so it must not vanish
   *  silently. */
  function touchOrWarn(agentId: string): void {
    if (!registry.touch(agentId)) {
      console.warn(
        `[rhumb] WARNING: mngr backend could not update lastActiveAt for agentId ${agentId}: ` +
          "no such record in the agent registry. The turn still ran, but this principal is not " +
          "tracked — its agentId->nativeId binding is missing, so it cannot be listed or stopped.",
      );
    }
  }

  /** `registry.markStopped` returns false when no record exists (I4).
   *  Unlike `touch`, swallowing this would be a correctness lie: `stop()`
   *  resolving normally tells the caller the principal is now retired, and
   *  the backend already throws rather than claim that when the CLI call
   *  fails (I3b). A record that cannot be marked is the same class of
   *  failure and gets the same treatment. */
  function markStoppedOrThrow(agentId: string): void {
    if (!registry.markStopped(agentId)) {
      throw new Error(
        `mngr: cannot mark agentId ${agentId} stopped: no such record in the agent registry`,
      );
    }
  }

  /** Waits for a NEW assistant reply to appear in the transcript (C1).
   *
   *  `mngr message` returns on SUBMISSION, not completion — it writes to
   *  the agent's stdin and there is no wait-for-reply flag (verified
   *  against 0.2.17; Phase 0's Q3 table). So at the instant it exits 0, the
   *  transcript typically holds only the operator's own `user_message`.
   *  Reading the transcript once and reporting whatever is there is what
   *  produced the C1 defect: a turn completing with `mngr message`'s CLI
   *  banner (or an empty string) presented to the operator as the model's
   *  answer, `isError: false`.
   *
   *  Polling `mngr transcript --format jsonl` rather than streaming `mngr
   *  event --follow`: `--follow` would give lower latency, but it needs a
   *  long-lived child process with incremental stdout, which `ExecFn` — a
   *  buffer-the-whole-output, resolve-once seam shared by every other call
   *  site — cannot express. Polling reuses `fetchTranscript` exactly as it
   *  already is, keeps the fake-exec unit tests honest (no streaming to
   *  simulate), and is sufficient because slice 1 emits no incremental
   *  events anyway: one `session` event, then one terminal event. Revisit
   *  when incremental streaming is actually wired.
   *
   *  Returns `null` on timeout, which the caller reports honestly rather
   *  than dressing up as an answer. */
  async function waitForNewAssistantReply(
    nativeId: string,
    before: TranscriptEntry[],
  ): Promise<TranscriptEntry | null> {
    const deadline = Date.now() + replyTimeoutMs;
    for (;;) {
      const after = await fetchTranscript(nativeId);
      const reply = newAssistantReply(before, after);
      if (reply) return reply;
      if (Date.now() >= deadline) return null;
      await sleep(replyPollIntervalMs);
    }
  }

  /** Snapshot of a live agent's transcript, or `null` when it cannot be read
   *  (non-zero exit). Individual unparseable or unrecognised lines are
   *  skipped, never thrown — see parseTranscriptLine.
   *
   *  One non-zero exit is NOT an unreadable transcript: mngr reports a
   *  brand-new agent that has not emitted anything yet as an ERROR (exit 1,
   *  `{"event":"error", …,"message":"No common transcript found for agent
   *  'X'. The agent may not have produced any transcript events yet."}`),
   *  not as an empty result. Verified against 0.2.17 on the pre-send read of
   *  a fresh agent's very first turn.
   *
   *  Collapsing that into `null` was actively harmful: `null` means
   *  UNKNOWABLE, which disables the delivery check and the new-vs-stale
   *  reply comparison for the whole turn — so the FIRST turn of EVERY mngr
   *  agent reported a bare CLI error to the operator while the model's real
   *  answer sat in the transcript, unread. Mapping it to `[]` is not a
   *  guess: mngr is asserting the agent has produced no events, i.e. there
   *  is no prior history for a "new" reply to be confused with, which is
   *  exactly what an empty baseline encodes. The match is deliberately
   *  narrow (that one error message) so any OTHER failure — a real
   *  unreadable transcript, a dead agent, a timeout — still returns `null`
   *  and still disables both checks. */
  async function fetchTranscript(nativeId: string): Promise<TranscriptEntry[] | null> {
    const res = await exec(argvTranscript(nativeId));
    if (res.code !== 0) return isNoTranscriptYetError(res.stdout) ? [] : null;
    const messages: TranscriptEntry[] = [];
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

    // Resolve-BEFORE-create, keyed on RHUMB_AGENT_ID_LABEL (A1) — adopt a
    // pre-existing agent Rhumb already labelled for THIS principal, instead
    // of unconditionally calling `create`. This is what actually fixes the
    // N1 orphan path, not just the discriminated result type above: if a
    // PRIOR ensure() call's `create` succeeded but the immediately-
    // following resolveNativeIdByLabel was UNKNOWABLE (leaving the
    // principal unbound, see below), this step is where that agent gets
    // adopted on a LATER call — instead of calling `create` again, which
    // Phase 0 documents fails once the branch `mngr/<name>` already exists
    // (permanently orphaning the agent if retried blindly). It also makes
    // `ensureAgent` idempotent under concurrent/repeated calls in general,
    // not just in the recovery case. This runs before name validation on
    // purpose: adoption never needs `name` (a stored, possibly-invalid
    // display name should not block adopting an agent that already exists
    // and is already correctly labelled).
    const preexisting = await resolveNativeIdByLabel(agentId);
    if (preexisting.status === "found") {
      return bindIfUnclaimed(agentId, preexisting.id);
    }

    const name = existing?.name ?? agentId;
    if (!VALID_MNGR_NAME.test(name)) {
      // Fail closed rather than hand an unsafe name to `create`.
      return { agentId, nativeId: null, backend: "mngr", reason: "invalid-name" };
    }

    // The record's own lineage (recorded at registry.create time), never
    // re-derived here — defaults to root when the record is absent (the
    // invalid-name / unregistered-agentId edge cases above).
    const lineage = { parentAgentId: existing?.parentAgentId ?? null, depth: existing?.depth ?? 0 };
    const res = await exec(argvCreate(name, agentId, credentialEnv, extraBlankedVars, spec, lineage));
    if (res.code !== 0) {
      // A genuine create failure (mngr's own exit code says so). Leave the
      // principal unbound; send() reports it as an error event rather than
      // throwing here.
      return { agentId, nativeId: null, backend: "mngr", reason: "create-failed" };
    }

    const resolved = await resolveNativeIdByLabel(agentId);
    if (resolved.status === "found") {
      return bindIfUnclaimed(agentId, resolved.id);
    }
    // Neither "found" branch fired. Deliberately NOT reported as
    // "create-failed" in either sub-case: `create`'s own exit code already
    // said it succeeded, and concluding failure here is exactly the N1
    // defect. The principal stays unbound for THIS call (there is no
    // confirmed id to hand back), but the two sub-cases differ in what
    // happens next, so they're reported distinctly (A2):
    if (resolved.status === "unknowable") {
      // The listing itself failed right after create succeeded. The
      // resolve-before-create step above will pick this agent up on a
      // later call once `list` is trustworthy again.
      return { agentId, nativeId: null, backend: "mngr", reason: "create-unconfirmed" };
    }
    // resolved.status === "not-found": a trustworthy listing genuinely
    // shows no agent under this label. Nothing was actually adopted, so a
    // later call will legitimately retry `create` via resolve-before-create
    // finding nothing (rather than a stale claim that the listing was
    // untrustworthy, which A2 flagged as inaccurate here).
    return { agentId, nativeId: null, backend: "mngr", reason: "create-not-found" };
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
      const res = await exec(argvSend(nativeId, prompt));

      if (res.code !== 0) {
        // A non-zero exit is NOT proof of non-delivery — reconcile against
        // the transcript first. This is not a rare path: against mngr
        // 0.2.17 it is the NORMAL one. `mngr message` sits for 90s and then
        // exits non-zero with "Timeout waiting for message submission
        // signal" on turns whose transcript timestamps show the prompt
        // delivered and answered within ~2s.
        const after = await fetchTranscript(nativeId);
        const delivered = before !== null && after !== null && after.length > before.length;
        if (delivered && before !== null) {
          // Submission is PROVEN (the transcript grew), so this turn is in
          // exactly the same state as a clean exit 0: waiting on the model.
          // Wait for the answer the same way, rather than reporting a
          // half-finished turn just because the CLI's own exit code was
          // grumpy about a signal it never saw. touch() first: submission
          // is proven even if the answer never arrives.
          touchOrWarn(ref.agentId);
          const reply = newAssistantReply(before, after) ?? (await waitForNewAssistantReply(nativeId, before));
          if (reply) {
            // Report what the transcript actually shows, not the exit code.
            onEvent({ type: "result", result: resultTextFor(reply), isError: false });
            return { ...ref, nativeId };
          }
          // Submitted, but no NEW assistant reply ever landed. Do NOT
          // synthesise a result from the operator's own prompt (a
          // `user_message` entry); report this honestly.
          onEvent({
            type: "error",
            message: `mngr: message delivered but not yet answered (${res.stderr.trim() || `exit ${res.code}`})`,
          });
          return { ...ref, nativeId };
        }
        onEvent({ type: "error", message: `mngr: ${res.stderr.trim() || `exit ${res.code}`}` });
        return { ...ref, nativeId };
      }

      // Exit 0 proves SUBMISSION, never completion (C1). `mngr message`
      // writes to the agent's stdin and returns; there is no
      // wait-for-reply flag. So this is where the turn actually waits for
      // the model — by polling the transcript for an assistant entry that
      // was not already there before the prompt was sent.
      touchOrWarn(ref.agentId);

      if (before === null) {
        // No trustworthy baseline: the PRE-send transcript read failed, so
        // "new" cannot be distinguished from "already there", and polling
        // could only ever surface a PREVIOUS turn's answer as this turn's
        // (the exact stale-reply failure `newAssistantReply` guards
        // against). Report the honest outcome immediately instead of
        // waiting out the timeout to reach the same conclusion.
        onEvent({
          type: "error",
          message:
            "mngr: message delivered but not yet answered (the pre-send transcript could not be read, " +
            "so a new assistant reply cannot be told apart from prior history)",
        });
        return { ...ref, nativeId };
      }

      const reply = await waitForNewAssistantReply(nativeId, before);
      if (reply) {
        onEvent({ type: "result", result: resultTextFor(reply), isError: false });
        return { ...ref, nativeId };
      }

      // Timed out with no NEW assistant entry. `res.stdout` is deliberately
      // NOT used as a fallback on this (or any) path: Phase 0 never
      // characterised `mngr message`'s stdout as carrying the assistant's
      // reply — it is a submission banner, or empty — and emitting it as
      // `{ type: "result", isError: false }` presented mngr's own CLI
      // chatter to the operator as the model's answer. Report the same
      // honest shape the non-zero-exit path already produces.
      onEvent({
        type: "error",
        message: `mngr: message delivered but not yet answered within ${replyTimeoutMs}ms (no new assistant reply appeared in the transcript)`,
      });
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
        markStoppedOrThrow(ref.agentId);
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
      markStoppedOrThrow(ref.agentId);
    },

    async transcript(ref) {
      if (!ref.nativeId) return null;
      const entries = await fetchTranscript(ref.nativeId);
      if (entries === null) return null;
      // Strip the internal finishReason field before returning — the public
      // TranscriptMessage shape is hand-mirrored in
      // client/src/lib/agentEvents.ts and must not gain a field the client
      // doesn't know about.
      return entries.map(({ finishReason: _ignored, ...m }) => m);
    },
  };
}
