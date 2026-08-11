import { Transcript } from "./Transcript";
import { Composer, type StagedFile } from "./Composer";
import type { TabState } from "../lib/chatStore";
import type { PendingItem, ResolvedItem } from "../lib/pendingStore";
import type { RosterEntry } from "../lib/tauri";

export function AgentPanel({
  tab,
  slashCommands,
  roster,
  me,
  onSend,
  pending,
  resolved,
  onResolve,
}: {
  tab: TabState;
  slashCommands: string[];
  roster: RosterEntry[];
  me: string | null;
  onSend: (text: string, files: StagedFile[]) => Promise<boolean>;
  pending: PendingItem[];
  resolved: ResolvedItem[];
  onResolve: (item: PendingItem, decision: "approve" | "deny", trust: boolean) => void | Promise<void>;
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
        roster={roster}
        me={me}
        busy={tab.openTurns > 0}
        pending={pending}
        resolved={resolved}
        onResolve={onResolve}
      />
      <Composer slashCommands={slashCommands} roster={roster} onSend={onSend} />
    </div>
  );
}
