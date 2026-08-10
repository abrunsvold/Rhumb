import type { OntologyNode } from "../lib/types";

export function NodeDetail({ node }: { node: OntologyNode }) {
  const props = Object.entries(node.props);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[#0d0f12]">
      <div className="flex flex-none flex-col gap-2 px-6 pb-3.5 pt-5">
        <span className="ey">{node.type}</span>
        <span className="title-lg text-[24px]">{node.title}</span>
        <span className="mn text-faint">{node.managed}</span>
      </div>
      {props.length > 0 && (
        <div className="mx-6 flex-none border border-line">
          {props.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[120px_1fr] gap-x-3.5 border-b border-raised bg-panel px-3 py-2.5">
              <span className="ey">{k}</span>
              <span className="mn truncate text-ink">{v}</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-2 px-6 pb-5 pt-4">
        <span className="ey">Edges</span>
        {node.relationships.map((r) => (
          <div key={`${r.edge}:${r.target}`} className="flex items-center gap-2.5 border-b border-raised py-1">
            <span className="mn whitespace-nowrap text-faint">{r.edge}</span>
            <span className="mn text-line-strong" aria-hidden>→</span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">{r.target}</span>
          </div>
        ))}
        {node.relationships.length === 0 && (
          <span className="text-[12.5px] leading-relaxed text-faint">
            No edges recorded — nothing depends on it, and it depends on nothing.
          </span>
        )}
      </div>
    </div>
  );
}
