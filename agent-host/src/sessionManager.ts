import type { AgentEvent } from "./types.js";
import type { AgentBackend, AgentRef } from "./backends/types.js";
import { createSdkBackend } from "./backends/sdk.js";

export type QueryFn = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<any>;

export class SessionManager {
  private readonly backend: AgentBackend;
  private readonly resolveAgentId?: (sessionId: string | undefined) => string;

  constructor(opts: {
    query?: QueryFn;
    /** Injected backend. When omitted, an SDK backend is built from `query`. */
    backend?: AgentBackend;
    model: string;
    workspace: string;
    permissionMode?: string;
    extraOptions?: Record<string, unknown>;
    /** Resolves an incoming wire `sessionId` (which may be `undefined`, on
     *  a brand-new turn) into the durable Rhumb `agentId` a backend needs.
     *
     *  Omitted for the SDK backend, and behaviour there is byte-identical
     *  to before this existed: `agentId` falls back to `sessionId ?? ""`,
     *  the SDK's own session_id doubling as both the Rhumb principal and
     *  the backend handle, with no registry involved and no principal ever
     *  minted (see the SDK-path comment in `run`).
     *
     *  Backends with a real principal lifecycle (mngr) need one, since
     *  their `agentId` and native handle are genuinely different values —
     *  without this, every mngr turn arrives with `agentId: ""`, which
     *  fails `VALID_MNGR_NAME` and no principal is ever created (fix
     *  round 1, C1). `index.ts` builds this closure over its own
     *  `AgentRegistry` and injects it here; `SessionManager` deliberately
     *  never imports the registry module itself, so it stays backend- and
     *  registry-agnostic. */
    resolveAgentId?: (sessionId: string | undefined) => string;
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
  }

  async run(
    prompt: string,
    sessionId: string | undefined,
    onEvent: (e: AgentEvent) => void,
  ): Promise<string> {
    // Slice 1 keeps the wire protocol: for the SDK path (no resolver
    // injected) the caller's sessionId is both the Rhumb principal and the
    // backend handle, exactly as before `resolveAgentId` existed. A backend
    // that needs a distinct durable principal (mngr) supplies a resolver
    // that mints or looks one up instead.
    const agentId = this.resolveAgentId ? this.resolveAgentId(sessionId) : (sessionId ?? "");
    const ref: AgentRef = {
      agentId,
      nativeId: sessionId ?? null,
      backend: this.backend.id,
    };
    const out = await this.backend.send(ref, prompt, onEvent);
    return out.nativeId ?? "";
  }
}
