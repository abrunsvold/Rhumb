import { useEffect, useRef, useState } from "react";
import { reduceAgent, appendUserMessage, initialAgentState, type AgentState } from "../lib/agentEvents";
import { openAgentStream, sendMessage, uploadFile } from "../lib/tauri";
import { Transcript } from "./Transcript";
import { Composer, type StagedFile } from "./Composer";

export function AgentPanel({ agentBase }: { agentBase: string }) {
  const [state, setState] = useState<AgentState>(initialAgentState);
  const [openTurns, setOpenTurns] = useState(0);
  const stops = useRef<Map<string, () => void>>(new Map());
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = state.sessionId;

  useEffect(() => {
    const map = stops.current;
    return () => {
      for (const stop of map.values()) stop();
      map.clear();
    };
  }, []);

  async function send(text: string, files: StagedFile[]): Promise<boolean> {
    let prompt = text;
    if (files.length > 0) {
      try {
        const paths: string[] = [];
        for (const f of files) paths.push(await uploadFile(agentBase, f.name, f.contentBase64));
        prompt = `${text}\n\n[Attached files: ${paths.join(", ")}]`;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        setState((prev) =>
          reduceAgent(prev, { type: "error", message: `Upload failed: ${detail}` }),
        );
        return false;
      }
    }
    setState((prev) => appendUserMessage(prev, text, files.map((f) => f.name)));
    const turnId = crypto.randomUUID();
    setOpenTurns((n) => n + 1);
    const stop = openAgentStream(agentBase, turnId, (event) => {
      setState((prev) => reduceAgent(prev, event));
      if (event.type === "result" || event.type === "error") {
        stops.current.get(turnId)?.();
        stops.current.delete(turnId);
        setOpenTurns((n) => Math.max(0, n - 1));
      }
    });
    stops.current.set(turnId, stop);
    await sendMessage(agentBase, turnId, prompt, sessionRef.current ?? undefined);
    return true;
  }

  return (
    <div className="flex h-full flex-col bg-panel">
      <Transcript messages={state.messages} busy={openTurns > 0} />
      <Composer slashCommands={state.slashCommands} onSend={send} />
    </div>
  );
}
