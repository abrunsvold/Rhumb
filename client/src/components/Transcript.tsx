import { useEffect, useRef, useState } from "react";
import type { TranscriptMessage } from "../lib/agentEvents";
import type { PendingItem, ResolvedItem } from "../lib/pendingStore";
import { ApprovalQueue } from "./ApprovalCard";
import { Markdown } from "./Markdown";

function Message({ m }: { m: TranscriptMessage }) {
  switch (m.kind) {
    case "user":
      return (
        <div data-kind="user" className="flex justify-end">
          <div className="max-w-[82%] whitespace-pre-wrap rounded-sm bg-raised px-3.5 py-2.5 text-[14px] leading-relaxed text-ink">
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
                  <span key={a} className="mn border border-line-strong px-1.5 py-0.5 text-faint">{a}</span>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    case "tool":
      return <ToolChip m={m} />;
    case "error":
      return (
        <div data-kind="error" className="max-w-[60ch] whitespace-pre-wrap text-[13px] text-danger">
          {m.text}
        </div>
      );
    case "result":
      return (
        <div data-kind="result" className="flex items-center gap-2.5">
          <span data-role="dot" className="h-[5px] w-[5px] shrink-0 rounded-full bg-faint" />
          <span className="text-[12.5px] text-faint">{m.text}</span>
        </div>
      );
    default:
      return (
        <div data-kind="text" className="max-w-[60ch] text-[14.5px] leading-[1.75] text-ink-soft">
          <Markdown text={m.text} />
        </div>
      );
  }
}

function ToolChip({ m }: { m: TranscriptMessage }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-kind="tool" className="max-w-[60ch] self-start">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-left text-[12.5px] text-faint">
        {m.toolName} · <span className="border-b border-line-strong text-muted">{open ? "hide" : "details"}</span>
      </button>
      {open && (
        <pre className="mt-1 max-h-48 overflow-auto border border-line bg-panel p-2 font-mono text-xs text-muted">
          {JSON.stringify(m.toolInput ?? null, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function Transcript({
  messages,
  busy,
  pending,
  resolved,
  onResolve,
}: {
  messages: TranscriptMessage[];
  busy: boolean;
  pending: PendingItem[];
  resolved: ResolvedItem[];
  onResolve: (item: PendingItem, decision: "approve" | "deny", trust: boolean) => void | Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const prevLen = useRef(messages.length);
  const prevPending = useRef(pending.length);

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
    } else if (messages.length > prevLen.current || pending.length > prevPending.current) {
      // A new approval card is appended below the fold exactly like a new
      // message, and the modal it replaced was unmissable — so it raises the
      // same pill. Tracked as its own ref rather than a combined length: a
      // pending resolving (-1) while a message arrives (+1) must still pill.
      setShowJump(true);
    }
    prevLen.current = messages.length;
    prevPending.current = pending.length;
  }, [messages, busy, pending.length, resolved.length]);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={scrollRef}
        onWheel={onUserScroll}
        onTouchMove={onUserScroll}
        onKeyDown={onUserScroll}
        data-testid="transcript"
        className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 pb-2.5 pt-7"
      >
        {messages.length === 0 && !busy && pending.length === 0 && resolved.length === 0 && (
          <p className="m-auto text-muted">Send a message to start a session.</p>
        )}
        {messages.map((m, i) => (
          <Message key={m.id ?? i} m={m} />
        ))}
        <ApprovalQueue pending={pending} resolved={resolved} onResolve={onResolve} />
        {busy && (
          <div className="flex items-center gap-2.5">
            <span className="h-[5px] w-[5px] rounded-full bg-accent" />
            <span className="text-[12.5px] text-faint">Working…</span>
          </div>
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
