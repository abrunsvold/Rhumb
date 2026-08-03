import type { AgentEvent } from "./types.js";
import type { AgentBackend, AgentRef } from "./backends/types.js";
import { createSdkBackend } from "./backends/sdk.js";

export type QueryFn = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<any>;

export class SessionManager {
  private readonly backend: AgentBackend;

  constructor(opts: {
    query?: QueryFn;
    /** Injected backend. When omitted, an SDK backend is built from `query`. */
    backend?: AgentBackend;
    model: string;
    workspace: string;
    permissionMode?: string;
    extraOptions?: Record<string, unknown>;
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
  }

  async run(
    prompt: string,
    sessionId: string | undefined,
    onEvent: (e: AgentEvent) => void,
  ): Promise<string> {
    // Slice 1 keeps the wire protocol: the caller's sessionId is both the
    // Rhumb principal and the backend handle for the SDK path.
    const ref: AgentRef = {
      agentId: sessionId ?? "",
      nativeId: sessionId ?? null,
      backend: this.backend.id,
    };
    const out = await this.backend.send(ref, prompt, onEvent);
    return out.nativeId ?? "";
  }
}
