import { Transcript } from "./Transcript";
import { Composer, type StagedFile } from "./Composer";
import type { TabState } from "../lib/chatStore";
import type { PendingItem, ResolvedItem } from "../lib/pendingStore";

export function AgentPanel({
  tab,
  slashCommands,
  onSend,
  pending,
  resolved,
  onResolve,
}: {
  tab: TabState;
  slashCommands: string[];
  onSend: (text: string, files: StagedFile[]) => Promise<boolean>;
  pending: PendingItem[];
  resolved: ResolvedItem[];
  onResolve: (item: PendingItem, decision: "approve" | "deny", trust: boolean) => void;
}) {
  return (
    <div className="flex h-full flex-col bg-panel">
      {tab.stale && (
        <div className="border-b border-line bg-raised px-3 py-1 text-xs text-muted">
          Live updates interrupted — reconnecting…
        </div>
      )}
      <Transcript
        messages={tab.agent.messages}
        busy={tab.openTurns > 0}
        pending={pending}
        resolved={resolved}
        onResolve={onResolve}
      />
      <Composer slashCommands={slashCommands} onSend={onSend} />
    </div>
  );
}
