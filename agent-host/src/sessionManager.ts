import type { AgentEvent } from "./types.js";

export type QueryFn = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<any>;

export class SessionManager {
  private readonly query: QueryFn;
  private readonly model: string;
  private readonly workspace: string;
  private readonly permissionMode: string;
  private readonly extraOptions: Record<string, unknown>;

  constructor(opts: {
    query: QueryFn;
    model: string;
    workspace: string;
    permissionMode?: string;
    extraOptions?: Record<string, unknown>;
  }) {
    this.query = opts.query;
    this.model = opts.model;
    this.workspace = opts.workspace;
    this.permissionMode = opts.permissionMode ?? "acceptEdits";
    this.extraOptions = opts.extraOptions ?? {};
  }

  async run(
    prompt: string,
    sessionId: string | undefined,
    onEvent: (e: AgentEvent) => void,
  ): Promise<string> {
    const options: Record<string, unknown> = {
      model: this.model,
      cwd: this.workspace,
      permissionMode: this.permissionMode,
    };
    if (sessionId) options.resume = sessionId;
    const merged = { ...options, ...this.extraOptions };

    let resolvedId = sessionId ?? "";
    try {
      for await (const message of this.query({ prompt, options: merged })) {
        if (message?.type === "system" && message?.subtype === "init") {
          resolvedId = message.session_id;
          onEvent({ type: "session", sessionId: resolvedId });
        } else if (message?.type === "result") {
          onEvent({
            type: "result",
            result: String(message.result ?? ""),
            isError: Boolean(message.is_error),
          });
        } else {
          onEvent({ type: "raw", message });
        }
      }
    } catch (err) {
      onEvent({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
    return resolvedId;
  }
}
