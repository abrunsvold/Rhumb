export function SurfaceFrame({
  lineage,
  onDetach,
  detachError,
  children,
}: {
  lineage: string[];
  onDetach?: () => void;
  detachError: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex h-10 flex-none items-center gap-2 overflow-x-auto border-b border-line px-5">
        {lineage.map((label, i) => (
          <span key={`${label}-${i}`} className="flex items-center gap-2">
            <span className={i === lineage.length - 1 ? "mn whitespace-nowrap text-ink" : "mn whitespace-nowrap text-faint"}>
              {label}
            </span>
            {i < lineage.length - 1 && <span className="mn text-line-strong" aria-hidden>→</span>}
          </span>
        ))}
        <div className="flex-1" />
        {detachError && <span className="mn shrink-0 text-danger">Detach failed</span>}
        {onDetach && (
          <button onClick={onDetach} className="mn shrink-0 whitespace-nowrap text-muted hover:text-ink">
            DETACH ↗
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
