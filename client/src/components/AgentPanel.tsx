import { useEffect, useRef, useState } from "react";
import { reduceAgent, initialAgentState, type AgentState } from "../lib/agentEvents";
import { openAgentStream, sendMessage } from "../lib/tauri";

export function AgentPanel({ agentBase }: { agentBase: string }) {
  const [state, setState] = useState<AgentState>(initialAgentState);
  const [draft, setDraft] = useState("");
  const stops = useRef<Map<string, () => void>>(new Map());

  useEffect(() => {
    const map = stops.current;
    return () => {
      for (const stop of map.values()) stop();
      map.clear();
    };
  }, []);

  async function submit() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    const turnId = crypto.randomUUID();
    const stop = openAgentStream(agentBase, turnId, (event) => {
      setState((prev) => reduceAgent(prev, event));
      if (event.type === "result" || event.type === "error") {
        stops.current.get(turnId)?.();
        stops.current.delete(turnId);
      }
    });
    stops.current.set(turnId, stop);
    await sendMessage(agentBase, turnId, text, state.sessionId ?? undefined);
  }

  return (
    <div>
      <ul>
        {state.messages.map((m, i) => (
          <li key={i} data-kind={m.kind}>
            {m.kind === "tool" ? `🔧 ${m.toolName}` : m.text}
          </li>
        ))}
      </ul>
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={submit}>Send</button>
    </div>
  );
}
