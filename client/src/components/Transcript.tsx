import { useEffect, useRef, useState } from "react";
import type { TranscriptMessage } from "../lib/agentEvents";

function ToolChip({ m }: { m: TranscriptMessage }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-kind="tool" className="self-start max-w-full">
      <button
        onClick={() => setOpen((o) => !o)}
        className="font-mono text-xs px-2 py-1 rounded border border-line bg-raised text-muted hover:text-ink"
      >
        🔧 {m.toolName}
      </button>
      {open && (
        <pre className="mt-1 max-h-48 overflow-auto rounded border border-line bg-raised p-2 font-mono text-xs text-muted">
          {JSON.stringify(m.toolInput ?? null, null, 2)}
        </pre>
      )}
    </div>
  );
}

function Message({ m }: { m: TranscriptMessage }) {
  switch (m.kind) {
    case "user":
      return (
        <div data-kind="user" className="self-end max-w-[85%] rounded-lg bg-accent-soft border border-line px-3 py-2 whitespace-pre-wrap">
          {m.text.startsWith("/") ? (
            (() => {
              const space = m.text.indexOf(" ");
              const cmd = space === -1 ? m.text : m.text.slice(0, space);
              return (
                <>
                  <span className="font-mono text-accent">{cmd}</span>
                  {space === -1 ? "" : m.text.slice(space)}
                </>
              );
            })()
          ) : (
            m.text
          )}
          {m.attachments && m.attachments.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {m.attachments.map((a) => (
                <span key={a} className="font-mono text-xs rounded bg-raised border border-line px-1.5 py-0.5 text-muted">
{a}
                </span>
              ))}
            </div>
          )}
        </div>
      );
    case "tool":
      return <ToolChip m={m} />;
    case "error":
      return (
        <div data-kind="error" className="self-start max-w-[85%] text-danger whitespace-pre-wrap">
          {m.text}
        </div>
      );
    case "result":
      return (
        <div data-kind="result" className="self-stretch flex items-center gap-2 text-xs text-muted">
          <span className="h-px flex-1 bg-line" />
          <span className="max-w-[70%] truncate">{m.text}</span>
          <span className="h-px flex-1 bg-line" />
        </div>
      );
    default:
      return (
        <div data-kind="text" className="self-start max-w-[85%] whitespace-pre-wrap">
          {m.text}
        </div>
      );
  }
}

export function Transcript({ messages, busy }: { messages: TranscriptMessage[]; busy: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const prevLen = useRef(messages.length);

  function atBottom(el: HTMLDivElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  // Only genuine user-initiated scrolling changes the follow decision — a raw
  // 'scroll' event also fires on reflow/programmatic scroll and must NOT unlatch.
  function onUserScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = atBottom(el);
    if (stickToBottom.current) setShowJump(false);
  }

  function jump() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottom.current = true;
    setShowJump(false);
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    } else if (messages.length > prevLen.current) {
      setShowJump(true);
    }
    prevLen.current = messages.length;
  }, [messages, busy]);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={scrollRef}
        onWheel={onUserScroll}
        onTouchMove={onUserScroll}
        onKeyDown={onUserScroll}
        data-testid="transcript"
        className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2"
      >
        {messages.length === 0 && !busy && (
          <p className="m-auto text-muted">Send a message to start a session.</p>
        )}
        {messages.map((m, i) => (
          <Message key={m.id ?? i} m={m} />
        ))}
        {busy && (
          <div className="self-start text-muted text-xs animate-pulse">thinking…</div>
        )}
      </div>
      {showJump && (
        <button
          onClick={jump}
          data-testid="jump-latest"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-line bg-raised px-3 py-1 text-xs text-ink shadow"
        >
          Jump to latest ↓
        </button>
      )}
    </div>
  );
}
