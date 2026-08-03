import type { AgentEvent, TranscriptMessage } from "../types.js";
import type { QueryFn } from "../sessionManager.js";
import type { AgentBackend, AgentRef, AgentSpec } from "./types.js";

/** The Agent SDK has no creation step: a session_id emerges from the first
 *  turn. So `ensure` is lazy and `list`/`stop` are inert. Lifecycle arrives
 *  only with the mngr backend. */
export function createSdkBackend(opts: { query: QueryFn; spec: AgentSpec }): AgentBackend {
  const { query, spec } = opts;

  return {
    id: "sdk",

    async ensure(agentId) {
      return { agentId, nativeId: null, backend: "sdk" };
    },

    async send(ref, prompt, onEvent) {
      const options: Record<string, unknown> = {
        model: spec.model,
        cwd: spec.workspace,
        permissionMode: spec.permissionMode,
      };
      if (ref.nativeId) options.resume = ref.nativeId;
      const merged = { ...options, ...spec.extraOptions };

      let resolvedId = ref.nativeId ?? "";
      try {
        for await (const message of query({ prompt, options: merged })) {
          if (message?.type === "system" && message?.subtype === "init") {
            resolvedId = message.session_id;
            const cmds = Array.isArray(message.slash_commands)
              ? message.slash_commands.filter((c: unknown): c is string => typeof c === "string")
              : undefined;
            onEvent(
              cmds && cmds.length > 0
                ? { type: "session", sessionId: resolvedId, slashCommands: cmds }
                : { type: "session", sessionId: resolvedId },
            );
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
      return { ...ref, nativeId: resolvedId === "" ? null : resolvedId };
    },

    async list(): Promise<AgentRef[]> {
      return [];
    },

    async stop(): Promise<void> {
      // No lifecycle to tear down.
    },

    async transcript(): Promise<TranscriptMessage[] | null> {
      // Transcript reading stays with the session service, which owns the
      // on-disk JSONL layout. Slice 4 revisits this.
      return null;
    },
  };
}
