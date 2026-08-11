import { useEffect, useState } from "react";
import { checkHealthTimed } from "../lib/tauri";
import { hostLabelOf } from "../lib/hostLabel";

const PROBE_INTERVAL_MS = 15000;

export function TopBar({
  title,
  turns,
  baseUrl,
}: {
  title: string;
  turns: number;
  baseUrl: string;
}) {
  const [health, setHealth] = useState<{ ok: boolean; ms: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function probe() {
      const r = await checkHealthTimed(baseUrl);
      if (!cancelled) setHealth(r);
    }
    void probe();
    const t = setInterval(() => void probe(), PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [baseUrl]);

  return (
    <header className="flex h-[52px] flex-none items-center gap-3.5 border-b border-line px-5">
      <span className="font-mono text-[13px] font-medium tracking-[0.22em] text-ink">RHUMB</span>
      <span className="h-4 w-px bg-line" />
      <span className="min-w-0 truncate text-[13.5px] text-ink">{title}</span>
      <span className="mn shrink-0 text-faint">
        {turns} {turns === 1 ? "turn" : "turns"}
      </span>
      <div className="flex-1" />
      <span className="mn shrink-0 text-faint">
        {hostLabelOf(baseUrl)}
        {health && (
          <>
            {" · "}
            {health.ok ? (
              <>
                <span className="text-ok">●</span> {health.ms}ms
              </>
            ) : (
              <span className="text-danger">unreachable</span>
            )}
          </>
        )}
      </span>
    </header>
  );
}
