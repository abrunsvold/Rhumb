import { Transcript } from "./Transcript";
import { Composer, type StagedFile } from "./Composer";
import { RoomStrip } from "./RoomStrip";
import type { TabState } from "../lib/chatStore";
import type { RosterEntry } from "../lib/tauri";

export function AgentPanel({
  tab,
  slashCommands,
  roster,
  me,
  onSend,
}: {
  tab: TabState;
  slashCommands: string[];
  roster: RosterEntry[];
  me: string | null;
  onSend: (text: string, files: StagedFile[]) => Promise<boolean>;
}) {
  return (
    <div className="flex h-full flex-col bg-panel">
      {tab.stale && (
        <div className="border-b border-line bg-raised px-3 py-1 text-xs text-muted">
          Live updates interrupted — reconnecting…
        </div>
      )}
      <RoomStrip
        presence={tab.agent.presence}
        queueDepth={tab.agent.queueDepth}
        roster={roster}
      />
      <Transcript messages={tab.agent.messages} roster={roster} me={me} busy={tab.openTurns > 0} />
      <Composer slashCommands={slashCommands} roster={roster} onSend={onSend} />
    </div>
  );
}
