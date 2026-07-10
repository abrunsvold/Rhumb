export type RailSection = "sessions" | "surfaces" | "gear";

const ITEMS: { id: RailSection; label: string; glyph: string }[] = [
  { id: "sessions", label: "Sessions", glyph: "💬" },
  { id: "surfaces", label: "System map", glyph: "▦" },
];

export function Rail({
  active,
  onSelect,
}: {
  active: RailSection | null;
  onSelect: (s: RailSection) => void;
}) {
  const btn = (id: RailSection, label: string, glyph: string) => (
    <button
      key={id}
      aria-label={label}
      title={label}
      onClick={() => onSelect(id)}
      className={
        active === id
          ? "flex h-10 w-10 items-center justify-center rounded bg-raised text-ink border border-line"
          : "flex h-10 w-10 items-center justify-center rounded text-muted hover:text-ink"
      }
    >
      <span aria-hidden>{glyph}</span>
    </button>
  );
  return (
    <nav className="flex w-12 flex-col items-center gap-1 border-r border-line bg-panel py-2">
      {ITEMS.map((i) => btn(i.id, i.label, i.glyph))}
      <div className="flex-1" />
      {btn("gear", "Connection", "⚙")}
    </nav>
  );
}
