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
}: {
  slashCommands: string[];
  onSend: (text: string, files: StagedFile[]) => Promise<boolean>;
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
      className="relative border-t border-line bg-panel p-2 flex flex-col gap-2"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length > 0) void stage(e.dataTransfer.files);
      }}
    >
      {matches.length > 0 && (
        <ul role="listbox" className="absolute bottom-full left-2 mb-1 w-64 rounded border border-line bg-raised shadow-lg overflow-hidden">
          {matches.map((c) => (
            <li key={c}>
              <button
                role="option"
                aria-selected={false}
                onClick={() => pick(c)}
                className="w-full text-left font-mono text-xs px-2 py-1.5 hover:bg-accent-soft"
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
      <div className="flex items-end gap-2">
        <label className="cursor-pointer rounded border border-line bg-raised px-2 py-1.5 text-muted hover:text-ink">
          📎
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
        <textarea
          ref={boxRef}
          rows={rows}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message the agent — / for commands"
          className="flex-1 resize-none rounded border border-line bg-raised px-2 py-1.5 outline-none placeholder:text-muted focus:border-accent"
        />
        <button
          onClick={() => void submit()}
          disabled={sending || (draft.trim().length === 0 && files.length === 0)}
          className="rounded bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-40"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
