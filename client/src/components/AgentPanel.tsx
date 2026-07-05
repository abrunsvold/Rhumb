import { Transcript } from "./Transcript";
import { Composer, type StagedFile } from "./Composer";
import type { TabState } from "../lib/chatStore";

export function AgentPanel({
  tab,
  slashCommands,
  onSend,
}: {
  tab: TabState;
  slashCommands: string[];
  onSend: (text: string, files: StagedFile[]) => Promise<boolean>;
}) {
  return (
    <div className="flex h-full flex-col bg-panel">
      {tab.stale && (
        <div className="border-b border-line bg-raised px-3 py-1 text-xs text-muted">
          Live updates interrupted — reconnecting…
        </div>
      )}
      {tab.historyNotice && (
        <div className="border-b border-line bg-raised px-3 py-1 text-xs text-muted">
          History unavailable for this session — showing live messages only.
        </div>
      )}
      <Transcript messages={tab.agent.messages} busy={tab.openTurns > 0} />
      <Composer slashCommands={slashCommands} onSend={onSend} />
    </div>
  );
}
