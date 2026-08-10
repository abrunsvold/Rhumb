import { useRef, useState } from "react";

export interface StagedFile {
  name: string;
  contentBase64: string;
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1)); // strip data:*;base64,
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function Composer({
  slashCommands,
  onSend,
  contextLabel,
}: {
  slashCommands: string[];
  onSend: (text: string, files: StagedFile[]) => Promise<boolean>;
  contextLabel?: string;
}) {
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [sending, setSending] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // Popup only while typing the leading command token: "/co", not "/compact now".
  const slashPrefix = /^\/\S*$/.test(draft) ? draft : null;
  const matches =
    slashPrefix !== null ? slashCommands.filter((c) => c.startsWith(slashPrefix)) : [];

  async function submit() {
    const text = draft.trim();
    if ((!text && files.length === 0) || sending) return;
    setSending(true);
    try {
      const ok = await onSend(text, files);
      if (ok) {
        setDraft("");
        setFiles([]);
        setStageError(null);
      }
    } finally {
      setSending(false);
    }
  }

  async function stage(list: FileList | File[]) {
    const accepted: StagedFile[] = [];
    const problems: string[] = [];
    for (const f of Array.from(list)) {
      if (f.size > MAX_UPLOAD_BYTES) {
        problems.push(`${f.name} is over the 20 MB limit`);
        continue;
      }
      try {
        accepted.push({ name: f.name, contentBase64: await fileToBase64(f) });
      } catch {
        problems.push(`${f.name} could not be read`);
      }
    }
    if (accepted.length > 0) setFiles((prev) => [...prev, ...accepted]);
    setStageError(problems.length > 0 ? problems.join("; ") : null);
  }

  function pick(cmd: string) {
    setDraft(`${cmd} `);
    boxRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (matches.length > 0 && slashPrefix !== null && slashPrefix.length > 1) {
        pick(matches[0]);
        return;
      }
      void submit();
    } else if (e.key === "Tab" && matches.length > 0) {
      e.preventDefault();
      pick(matches[0]);
    }
  }

  const rows = Math.min(8, Math.max(1, draft.split("\n").length));

  return (
    <div
      className="relative flex flex-none flex-col gap-3 border-t border-line px-6 pb-4 pt-4.5"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length > 0) void stage(e.dataTransfer.files);
      }}
    >
      {matches.length > 0 && (
        <ul role="listbox" className="absolute bottom-full left-2 mb-1 w-64 overflow-hidden rounded border border-line bg-panel shadow-lg">
          {matches.map((c) => (
            <li key={c}>
              <button
                role="option"
                aria-selected={false}
                onClick={() => pick(c)}
                className="w-full px-2 py-1.5 text-left font-mono text-xs hover:bg-raised"
              >
                {c}
              </button>
            </li>
          ))}
        </ul>
      )}
      {stageError && <p className="text-xs text-danger">{stageError}</p>}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {files.map((f) => (
            <span key={f.name} className="font-mono text-xs rounded bg-raised border border-line px-1.5 py-0.5 flex items-center gap-1">
              📎 {f.name}
              <button
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}
                className="text-muted hover:text-danger"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={boxRef}
        rows={rows}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Reply, or ask for something new…"
        className="max-h-[132px] w-full min-w-0 resize-none bg-transparent text-[15px] leading-relaxed outline-none placeholder:text-faint"
      />
      <div className="flex items-center gap-4">
        <label className="cursor-pointer text-[11.5px] text-faint hover:text-muted">
          drop files to attach
          <input
            type="file"
            multiple
            aria-label="Attach files"
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void stage(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        <span className="text-[11.5px] text-faint">/ for commands</span>
        <div className="flex-1" />
        {draft.trim().length > 0 || files.length > 0 ? (
          <button
            onClick={() => void submit()}
            disabled={sending}
            className="flex items-center gap-2 whitespace-nowrap text-[12.5px] text-accent disabled:opacity-40"
          >
            {sending ? "Sending…" : "Send"}
            <span className="mn text-faint" aria-hidden>⏎</span>
          </button>
        ) : (
          contextLabel && <span className="text-[11.5px] text-faint">{contextLabel}</span>
        )}
      </div>
    </div>
  );
}
