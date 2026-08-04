import type { AgentEvent } from "./types.js";
import type { AgentBackend, AgentRef } from "./backends/types.js";
import { createSdkBackend } from "./backends/sdk.js";

export type QueryFn = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<any>;

/** What a `resolveAgentId` resolver hands back: the durable Rhumb `agentId`
 *  to use, AND the `nativeId` to trust for it — see the doc comment on
 *  `SessionManager`'s `resolveAgentId` option for why `nativeId` must come
 *  from the resolver (i.e. from the backend's own registry), never from the
 *  wire-supplied `sessionId` directly (fix round 3, A1). */
export interface ResolvedAgentIdentity {
  agentId: string;
  nativeId: string | null;
}

export class SessionManager {
  private readonly backend: AgentBackend;
  private readonly resolveAgentId?: (sessionId: string | undefined) => ResolvedAgentIdentity;
  private readonly releaseAgentId?: (agentId: string) => void;

  constructor(opts: {
    query?: QueryFn;
    /** Injected backend. When omitted, an SDK backend is built from `query`. */
    backend?: AgentBackend;
    model: string;
    workspace: string;
    permissionMode?: string;
    extraOptions?: Record<string, unknown>;
    /** Resolves an incoming wire `sessionId` (which may be `undefined`, on
     *  a brand-new turn) into the durable Rhumb `agentId` a backend needs,
     *  AND the `nativeId` to trust for it.
     *
     *  Omitted for the SDK backend, and behaviour there is byte-identical
     *  to before this existed: `run` falls back to `{ agentId: sessionId ??
     *  "", nativeId: sessionId ?? null }` — the SDK's own session_id
     *  doubling as both the Rhumb principal and the backend handle (and
     *  the resume id `createSdkBackend` needs), with no registry involved
     *  and no principal ever minted (see the SDK-path comment in `run`).
     *
     *  Backends with a real principal lifecycle (mngr) need one, since
     *  their `agentId` and native handle are genuinely different values —
     *  without this, every mngr turn arrives with `agentId: ""`, which
     *  fails `VALID_MNGR_NAME` and no principal is ever created (fix
     *  round 1, C1).
     *
     *  `nativeId` MUST come from the resolver's own lookup (ultimately
     *  `registry.get`/`registry.list` in index.ts), never by echoing the
     *  incoming `sessionId` as-is (fix round 3, A1). Before A1, `run` set
     *  `nativeId: sessionId ?? null` unconditionally, which meant an
     *  arbitrary or foreign wire `sessionId` — one that never went through
     *  this backend's own create/adoption flow, e.g. an agent a human
     *  created directly on the box — was sent to verbatim, bypassing
     *  `mngr.ts`'s ownership check entirely (mngr's `send()` only calls
     *  `ensureAgent`, which is what actually verifies ownership, when
     *  `nativeId` is falsy). Deriving `nativeId` from the resolver's own
     *  registry lookup means an unrecognised or foreign `sessionId` can
     *  never become a trusted `nativeId` — the resolver either finds it
     *  bound to a principal Rhumb itself created, or treats it as
     *  unrecognised and resolves/mints a principal with `nativeId: null`
     *  instead, which routes back through `ensureAgent`.
     *
     *  `index.ts` builds this closure over its own `AgentRegistry` and
     *  injects it here; `SessionManager` deliberately never imports the
     *  registry module itself, so it stays backend- and registry-agnostic. */
    resolveAgentId?: (sessionId: string | undefined) => ResolvedAgentIdentity;
    /** Called once `backend.send(...)` settles — success OR throw — with
     *  the `agentId` this turn resolved to. Paired with `resolveAgentId`:
     *  index.ts's mngr resolver marks a principal "in flight" the moment it
     *  hands it out, so a concurrent turn cannot reuse it via
     *  reuse-before-mint (fix round 3, A2) and collide two conversations
     *  onto one agent/transcript (fix round 4, B2). This is how that
     *  in-flight mark gets cleared. Called from a `finally`, specifically
     *  so a thrown `send()` still releases the principal — an unreleased
     *  principal after a crashed turn would otherwise stay permanently
     *  ineligible for reuse, silently growing `agents.json` on every
     *  crash, which is the same class of leak A2 fixed for ordinary
     *  failures.
     *
     *  Omitted for the SDK path (and whenever `resolveAgentId` is also
     *  omitted), and behaviour there is exactly as before this option
     *  existed: nothing is called, nothing tracked. */
    releaseAgentId?: (agentId: string) => void;
  }) {
    if (opts.backend) {
      this.backend = opts.backend;
    } else {
      if (!opts.query) throw new Error("SessionManager requires either `query` or `backend`.");
      this.backend = createSdkBackend({
        query: opts.query,
        spec: {
          model: opts.model,
          workspace: opts.workspace,
          permissionMode: opts.permissionMode ?? "acceptEdits",
          extraOptions: opts.extraOptions ?? {},
        },
      });
    }
    this.resolveAgentId = opts.resolveAgentId;
    this.releaseAgentId = opts.releaseAgentId;
  }

  async run(
    prompt: string,
    sessionId: string | undefined,
    onEvent: (e: AgentEvent) => void,
  ): Promise<string> {
    // Slice 1 keeps the wire protocol: for the SDK path (no resolver
    // injected) the caller's sessionId is both the Rhumb principal and the
    // backend handle — the resume id — exactly as before `resolveAgentId`
    // existed. A backend that needs a distinct durable principal (mngr)
    // supplies a resolver that derives BOTH agentId and nativeId from its
    // own registry instead of trusting the wire (see the resolveAgentId
    // doc comment above, fix round 3 A1, for why nativeId in particular
    // must never come from sessionId directly on that path).
    const resolved = this.resolveAgentId
      ? this.resolveAgentId(sessionId)
      : { agentId: sessionId ?? "", nativeId: sessionId ?? null };
    const ref: AgentRef = {
      agentId: resolved.agentId,
      nativeId: resolved.nativeId,
      backend: this.backend.id,
    };
    try {
      const out = await this.backend.send(ref, prompt, onEvent);
      return out.nativeId ?? "";
    } finally {
      // Runs on the success path too, not just on throw: a principal must
      // stop being "in flight" the moment ITS turn is done, regardless of
      // outcome — see the releaseAgentId doc comment above (fix round 4, B2).
      this.releaseAgentId?.(resolved.agentId);
    }
  }
}
