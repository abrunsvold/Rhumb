import { useState } from "react";
import { reduceAgent, initialAgentState, type AgentState } from "../lib/agentEvents";
import { openAgentStream, sendMessage } from "../lib/tauri";

export function AgentPanel({ agentBase }: { agentBase: string }) {
  const [state, setState] = useState<AgentState>(initialAgentState);
  const [draft, setDraft] = useState("");

  async function submit() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    const turnId = crypto.randomUUID();
    // Open the stream first (stream-first), then send.
    openAgentStream(agentBase, turnId, (event) => {
      setState((prev) => reduceAgent(prev, event));
    });
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
