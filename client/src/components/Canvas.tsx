import type { Tab } from "../lib/registryStore";

export function Canvas({ dashboardBase, active }: { dashboardBase: string; active: Tab | null }) {
  if (!active) {
    return (
      <p className="m-auto max-w-xs text-center text-[13px] text-faint">
        No surfaces yet — the agent will publish dashboards here.
      </p>
    );
  }
  return (
    <iframe
      title={active.title}
      src={`${dashboardBase}${active.url}`}
      sandbox="allow-scripts allow-same-origin"
      className="h-full w-full flex-1 border-0 bg-white"
    />
  );
}
