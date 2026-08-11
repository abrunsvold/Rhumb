# Rhumb Client 5a Reskin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin the existing Rhumb Tauri client to the "Rhumb Client 5a" design — new chrome, new layout, transcript-inline approvals — without changing the agent-host or dashboard-host contracts.

**Architecture:** This is a face, not a new system. Every data path stays exactly as it is: all I/O goes through the Rust `invoke()` proxy commands in `src/lib/tauri.ts`, surfaces stay sandboxed `<iframe>`s of dashboard-host URLs, and the chat store / session streaming logic is untouched. What changes is the component tree above that data: a three-column grid replaces the icon rail + collapsible aside, the Tailwind theme is retoned, and the global `ConfirmationDialog` modal becomes an inline card in the transcript.

**Tech Stack:** React 18, TypeScript 5.5, Tailwind v4 (CSS-first `@theme` in `src/app.css`), Vite 5, Vitest 2 + Testing Library, Tauri 2.

---

## Global Constraints

- **No host contract changes in Tasks 1–14.** Do not add, remove, or change any route in `agent-host/` or `dashboard-host/`. Do not change `src/lib/types.ts` interfaces that are marked as hand-mirrored from a host (`AgentEvent`, `OntologyNode`). Task 15 is the single exception and is explicitly optional.
- **The surface pane body stays an `<iframe>`.** `sandbox="allow-scripts allow-same-origin"` must remain on it, and the detach path in `Canvas.tsx:20-30` must keep its `surface:<id>` window label and its comment. That label intentionally matches no capability in `src-tauri/capabilities/default.json`. Do not add one.
- **Never render a value the client does not have.** The mock shows `acceptEdits`, a `41ms` latency, and per-surface capability badges (`read-write`, `actions gated`, `read-only`). Only latency is knowable client-side today. Where data is absent, render nothing — not a plausible default. See "Design elements and their data sources" below.
- **Ship no font files.** The design project inherits `neuropol.woff` and the token set from `future-micro-mold-design-system`, which is a different product's brand. Use system stacks only.
- **Exact palette** (hex values are normative, taken from the mock):
  `bg #0a0b0d` · `panel #111316` · `raised #16191d` · `line #1f2328` · `line-strong #2a2f36` · `ink #f4f5f7` · `ink-soft #d7dae0` · `muted #9ba2ac` · `faint #5a616b` · `accent #ff5a1f` · `ok #3dd68c` · `warn #ffb020` · `danger #ff4d4d`
- **Every task ends green.** `npm test` and `npm run typecheck` from `client/` must both pass before the commit step. Tasks that change a component with an existing test file must update that test file in the same task.
- **Commit messages** use Conventional Commits and end with the repo's trailer:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

---

## How the current system works

Read this before Task 1. The plan's task boundaries assume it.

**Process shape.** A Tauri 2 desktop app. React renders in a webview; every network call goes through Rust commands in `src-tauri/src/proxy.rs`, wrapped by thin TypeScript functions in `src/lib/tauri.ts`. Streams (SSE) come back over a Tauri `Channel`. The webview itself never talks to a host directly — identity-mode hosts require a `Sec-Rhumb-Control` header that browser JS is forbidden from setting, so the Rust proxy is the only thing that can reach them.

**Two hosts.** `agentBase` (agent-host) owns sessions, turns, file uploads, the ontology, and infra pendings. `dashboardBase` (dashboard-host) owns the surface registry and data pendings. Both derive from one `baseUrl` via `agentBaseOf` / `dashboardBaseOf`.

**Boot.** `App.tsx` loads config; empty → `ConnectionScreen`, otherwise → `Workspace` plus a globally-mounted `ConfirmationDialog` overlay.

**Layout today.** `Workspace.tsx` renders a 48px icon `Rail` → a 256px collapsible `<aside>` (one of `GearPanel` / `SessionsPanel` / `OntologyPanel`) → a resizable chat column (`w-2/5`, `resize-x`) holding `ChatTabs` + `AgentPanel` → `Canvas` filling the rest.

**Chat.** `useChatSessions` holds a multi-tab `ChatStore`. Each tab has an `AgentState` (`sessionId`, `slashCommands`, `messages`). Two stream kinds run at once: a per-session stream (attached when a session opens) and a per-turn stream (opened per send). Draft tabs keyed `draft:<uuid>` promote to real session ids on the first `session` event. `TranscriptMessage.kind` is one of `user | text | tool | result | error`.

**Surfaces.** `openRegistryStream` pushes a `RegistrySnapshot`; `reduceRegistry` flattens it to `Tab[]` of `{id, title, url}`. `Canvas` renders `<iframe src={dashboardBase + tab.url}>`. Detach opens a Tauri `WebviewWindow` with no IPC capability.

**Ontology.** `getOntology(agentBase)` returns `{nodes, syncedAt, syncError}`. Each node has `type`, prefixed `id`, `title`, `managed`, `props`, and `relationships: {edge, target}[]`. `groupNodes` buckets by a fixed type list; `registryIdFor` maps a `dashboard-*` node to its registry id.

**Approvals.** Two SSE streams — data pendings from dashboard-host, infra pendings from agent-host — reduce into one `PendingItem[]` queue in `ConfirmationDialog`. Data ops are `{kind: "insert"|"update"|"delete"|"select", table, ...}`. `resolvePending(base, id, decision, trustSurface)` resolves data ones; `resolveInfraPending` handles infra. Trust pairs `{source, surfaceId}` persist server-side in `data-trust.json`; a trusted non-delete executes immediately with `auth: "trust"`, a delete always re-gates.

**Tests.** 19 files under `client/test/`, Vitest + jsdom + Testing Library. The house pattern is `vi.mock("../src/lib/tauri", () => ({...}))` with every used export stubbed.

## Design elements and their data sources

| Mock element | Real source | Verdict |
|---|---|---|
| Session title, turn count | `TabState.title`; count `messages.filter(kind === "user")` | Real |
| `● 41ms` | time a `checkHealth` round trip in the client | Real (Task 1) |
| `bmwbox` host label | hostname parsed from `baseUrl` | Real (Task 1) |
| `acceptEdits` | agent-host config, **never sent to the client** | Omit until Task 15 |
| Session list, grouping, previews | `listSessions` → `SessionMeta` (`preview`, `lastActiveAt`) | Real |
| MAP tree, node props, edges | `getOntology` → `OntologyNode` | Real |
| Lineage breadcrumb | derived from `OntologyNode.relationships` | Real (Task 6) |
| `read-write` / `read-only` badge | trust state lives in `data-trust.json`, **no read endpoint** | Omit until Task 15 |
| `SURFACES 6 · NODES 34 · EDGES 51` | registry length, node count, summed relationships | Real (Task 12) |
| `QUEUE 1 held` | pending queue length | Real (Task 12) |
| Table / board / runbook / ACL bodies | **mock content** — really an agent-authored page in an iframe | Frame only (Task 6) |

The last row is the one to internalize: those four surface bodies are illustrations of what an agent might publish, not components to build. The plan builds the *frame* around them.

---

## File Structure

**Create**
- `src/components/TopBar.tsx` — app title bar: session title, turn count, host status chip
- `src/components/Sidebar.tsx` — left column shell: SESSIONS / MAP / HOST tabs
- `src/components/HostPanel.tsx` — HOST tab body (replaces `GearPanel.tsx`)
- `src/components/SurfaceFrame.tsx` — surface pane header (lineage, detach) + iframe body
- `src/components/NodeDetail.tsx` — ontology node detail rendered in the surface pane
- `src/components/ApprovalCard.tsx` — one pending/resolved approval, inline in the transcript
- `src/components/TelemetryBar.tsx` — bottom counters strip
- `src/lib/lineage.ts` — `buildLineage(nodes, nodeId)` pure function
- `src/lib/opSummary.ts` — `summarizeOp(item)` → human sentence for an approval card
- `src/lib/hostLabel.ts` — `hostLabelOf(baseUrl)` → short hostname
- test files mirroring each of the above

**Modify**
- `src/app.css` — theme tokens, `.ey` / `.mn` utilities
- `src/components/Workspace.tsx` — three-column grid; owns pending queue
- `src/components/SessionsPanel.tsx` — search, grouping, two-line rows
- `src/components/OntologyPanel.tsx` — MAP tree, node selection
- `src/components/Transcript.tsx` — restyled kinds, renders approvals
- `src/components/Composer.tsx` — borderless input, hint row
- `src/components/ChatTabs.tsx` — restyle
- `src/components/Canvas.tsx` — body only; header moves to `SurfaceFrame`
- `src/components/ConnectionScreen.tsx` — restyle
- `src/components/AgentPanel.tsx` — thread approval props through
- `src/App.tsx` — drop the `ConfirmationDialog` mount
- `src/lib/pendingStore.ts` — add `ResolvedItem`
- `src/lib/tauri.ts` — add `checkHealthTimed`

**Delete**
- `src/components/Rail.tsx` + `src/components/GearPanel.tsx` (+ any tests referencing them)
- `src/components/ConfirmationDialog.tsx` + `test/ConfirmationDialog.test.tsx` (superseded by `ApprovalCard`)

---

### Task 1: Theme tokens, type utilities, and the top bar

**Files:**
- Modify: `client/src/app.css:1-20`
- Create: `client/src/lib/hostLabel.ts`
- Create: `client/src/components/TopBar.tsx`
- Modify: `client/src/lib/tauri.ts:68-70`
- Test: `client/test/hostLabel.test.ts`, `client/test/TopBar.test.tsx`

**Interfaces:**
- Consumes: `checkHealth` from `src/lib/tauri.ts`
- Produces: `hostLabelOf(baseUrl: string): string`; `checkHealthTimed(base: string): Promise<{ok: boolean; ms: number}>`; `<TopBar title={string} turns={number} baseUrl={string} />`

- [ ] **Step 1: Write the failing test for `hostLabelOf`**

```ts
// client/test/hostLabel.test.ts
import { describe, it, expect } from "vitest";
import { hostLabelOf } from "../src/lib/hostLabel";

describe("hostLabelOf", () => {
  it("takes the first label of a tailnet hostname", () => {
    expect(hostLabelOf("https://bmwbox.tail9c2e.ts.net")).toBe("bmwbox");
  });

  it("keeps a bare hostname", () => {
    expect(hostLabelOf("http://localhost:8787")).toBe("localhost");
  });

  it("keeps an IP address whole", () => {
    expect(hostLabelOf("http://192.168.1.24:8787")).toBe("192.168.1.24");
  });

  it("returns an empty string for an unparseable base", () => {
    expect(hostLabelOf("")).toBe("");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && npx vitest run test/hostLabel.test.ts`
Expected: FAIL — cannot resolve `../src/lib/hostLabel`

- [ ] **Step 3: Implement `hostLabelOf`**

```ts
// client/src/lib/hostLabel.ts

// Short label for the status chip: "bmwbox" out of
// "bmwbox.tail9c2e.ts.net". IPv4 has no meaningful first label, so it stays
// whole rather than being cut to a single octet.
export function hostLabelOf(baseUrl: string): string {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return "";
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  return host.split(".")[0] ?? host;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd client && npx vitest run test/hostLabel.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Retone the theme**

Replace the `@theme` block at the top of `client/src/app.css` (currently lines 3-15) with:

```css
@theme {
  --color-bg: #0a0b0d;
  --color-panel: #111316;
  --color-raised: #16191d;
  --color-line: #1f2328;
  --color-line-strong: #2a2f36;
  --color-ink: #f4f5f7;
  --color-ink-soft: #d7dae0;
  --color-muted: #9ba2ac;
  --color-faint: #5a616b;
  --color-accent: #ff5a1f;
  --color-accent-soft: #16191d;
  --color-ok: #3dd68c;
  --color-warn: #ffb020;
  --color-danger: #ff4d4d;
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --font-editorial: ui-serif, Georgia, "Times New Roman", serif;
}
```

`--color-accent-soft` is kept (rather than deleted) because `Transcript` and `ChatTabs` still reference it; it is remapped to the design's raised tone so the blue disappears without touching those files yet.

Then append to the `@layer components` block in the same file:

```css
  /* Eyebrow: uppercase mono label above a group. */
  .ey {
    font: 400 10px/1 var(--font-mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-faint);
  }
  /* Mono metadata: timestamps, counts, ids, chips. */
  .mn {
    font: 400 11px/1.4 var(--font-mono);
    letter-spacing: 0.04em;
  }
  /* Surface and panel headings. */
  .title-lg {
    font: 450 22px/1.1 var(--font-sans);
    letter-spacing: -0.02em;
    color: var(--color-ink);
  }
  /* The italic fragment inside a heading ("· 6 match"). */
  .title-note {
    font-family: var(--font-editorial);
    font-style: italic;
    font-weight: 300;
    color: var(--color-accent);
  }
```

- [ ] **Step 6: Add `checkHealthTimed`**

Append to `client/src/lib/tauri.ts` (after `checkHealth`, currently line 70):

```ts
// The host exposes no latency figure, so the client measures its own round
// trip through the Rust proxy. That includes proxy overhead, which is the
// number the operator actually experiences.
export async function checkHealthTimed(base: string): Promise<{ ok: boolean; ms: number }> {
  const started = performance.now();
  try {
    const ok = await checkHealth(base);
    return { ok, ms: Math.round(performance.now() - started) };
  } catch {
    return { ok: false, ms: Math.round(performance.now() - started) };
  }
}
```

- [ ] **Step 7: Write the failing test for `TopBar`**

```tsx
// client/test/TopBar.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { TopBar } from "../src/components/TopBar";
import { checkHealthTimed } from "../src/lib/tauri";

vi.mock("../src/lib/tauri", () => ({
  checkHealthTimed: vi.fn().mockResolvedValue({ ok: true, ms: 41 }),
}));

beforeEach(() => {
  vi.mocked(checkHealthTimed).mockClear();
});

describe("TopBar", () => {
  it("shows the wordmark, session title, and turn count", () => {
    render(<TopBar title="Printer farm tracker" turns={3} baseUrl="https://bmwbox.tail9c2e.ts.net" />);
    expect(screen.getByText("RHUMB")).toBeTruthy();
    expect(screen.getByText("Printer farm tracker")).toBeTruthy();
    expect(screen.getByText("3 turns")).toBeTruthy();
  });

  it("singularizes a single turn", () => {
    render(<TopBar title="x" turns={1} baseUrl="https://bmwbox.tail9c2e.ts.net" />);
    expect(screen.getByText("1 turn")).toBeTruthy();
  });

  it("shows the host label and measured latency once the probe resolves", async () => {
    render(<TopBar title="x" turns={0} baseUrl="https://bmwbox.tail9c2e.ts.net" />);
    await waitFor(() => expect(screen.getByText(/bmwbox/)).toBeTruthy());
    expect(screen.getByText(/41ms/)).toBeTruthy();
  });

  it("reports an unreachable host instead of a latency figure", async () => {
    vi.mocked(checkHealthTimed).mockResolvedValueOnce({ ok: false, ms: 3000 });
    render(<TopBar title="x" turns={0} baseUrl="https://bmwbox.tail9c2e.ts.net" />);
    await waitFor(() => expect(screen.getByText(/unreachable/)).toBeTruthy());
    expect(screen.queryByText(/3000ms/)).toBeNull();
  });
});
```

- [ ] **Step 8: Run it and confirm it fails**

Run: `cd client && npx vitest run test/TopBar.test.tsx`
Expected: FAIL — cannot resolve `../src/components/TopBar`

- [ ] **Step 9: Implement `TopBar`**

```tsx
// client/src/components/TopBar.tsx
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
```

- [ ] **Step 10: Run the whole suite and typecheck**

Run: `cd client && npm test && npm run typecheck`
Expected: PASS. The theme change alters no assertions — existing tests match on text and roles, not colors.

- [ ] **Step 11: Commit**

```bash
git add client/src/app.css client/src/lib/hostLabel.ts client/src/lib/tauri.ts client/src/components/TopBar.tsx client/test/hostLabel.test.ts client/test/TopBar.test.tsx
git commit -m "feat(client): retone theme to 5a palette and add the top bar

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Sidebar with SESSIONS / MAP / HOST tabs

Replaces the icon `Rail` plus its collapsible aside with a fixed 272px column carrying three text tabs. `Workspace` keeps rendering the same three panel bodies; only the chrome around them changes.

**Files:**
- Create: `client/src/components/Sidebar.tsx`
- Create: `client/src/components/HostPanel.tsx`
- Delete: `client/src/components/Rail.tsx`, `client/src/components/GearPanel.tsx`
- Modify: `client/src/components/Workspace.tsx:1-100`
- Test: `client/test/Sidebar.test.tsx`; modify `client/test/Workspace.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `type SidebarTab = "sessions" | "map" | "host"`; `<Sidebar active={SidebarTab} onSelect={(t: SidebarTab) => void}>{children}</Sidebar>`; `<HostPanel agentBase={string} dashboardBase={string} onDisconnect={() => void} />`

- [ ] **Step 1: Write the failing test**

```tsx
// client/test/Sidebar.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "../src/components/Sidebar";

describe("Sidebar", () => {
  it("renders the three tabs and marks the active one", () => {
    render(
      <Sidebar active="sessions" onSelect={vi.fn()}>
        <p>body</p>
      </Sidebar>,
    );
    expect(screen.getByRole("tab", { name: "SESSIONS" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "MAP" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tab", { name: "HOST" }).getAttribute("aria-selected")).toBe("false");
  });

  it("renders its children as the panel body", () => {
    render(
      <Sidebar active="map" onSelect={vi.fn()}>
        <p>body</p>
      </Sidebar>,
    );
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("reports the tab that was clicked", async () => {
    const onSelect = vi.fn();
    render(
      <Sidebar active="sessions" onSelect={onSelect}>
        <p>body</p>
      </Sidebar>,
    );
    await userEvent.click(screen.getByRole("tab", { name: "HOST" }));
    expect(onSelect).toHaveBeenCalledWith("host");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && npx vitest run test/Sidebar.test.tsx`
Expected: FAIL — cannot resolve `../src/components/Sidebar`

- [ ] **Step 3: Implement `Sidebar`**

```tsx
// client/src/components/Sidebar.tsx
export type SidebarTab = "sessions" | "map" | "host";

const TABS: { id: SidebarTab; label: string }[] = [
  { id: "sessions", label: "SESSIONS" },
  { id: "map", label: "MAP" },
  { id: "host", label: "HOST" },
];

export function Sidebar({
  active,
  onSelect,
  children,
}: {
  active: SidebarTab;
  onSelect: (t: SidebarTab) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden bg-panel">
      <div role="tablist" aria-label="Sidebar" className="flex flex-none gap-4 px-4 pb-3.5 pt-4">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={active === t.id}
            onClick={() => onSelect(t.id)}
            className={
              active === t.id
                ? "ey border-b border-accent pb-[5px] text-ink"
                : "ey border-b border-transparent pb-[5px] hover:text-muted"
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd client && npx vitest run test/Sidebar.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Implement `HostPanel`**

```tsx
// client/src/components/HostPanel.tsx
export function HostPanel({
  agentBase,
  dashboardBase,
  onDisconnect,
}: {
  agentBase: string;
  dashboardBase: string;
  onDisconnect: () => void;
}) {
  return (
    <div className="flex flex-col gap-3.5 px-4">
      <div className="flex flex-col gap-1.5">
        <span className="ey">Agent host</span>
        <span className="mn truncate text-ink">{agentBase}</span>
        <span className="ey mt-1.5">Dashboard host</span>
        <span className="mn truncate text-ink">{dashboardBase}</span>
      </div>
      <button
        onClick={onDisconnect}
        className="mn self-start whitespace-nowrap border border-line-strong px-2.5 py-1.5 text-muted hover:border-danger hover:text-danger"
      >
        DISCONNECT
      </button>
    </div>
  );
}
```

Identity (`anders@ · allowlisted` in the mock) is deliberately absent: `checkIdentity` returns an HTTP status, not a username, and there is no endpoint that reports who the caller is. Task 15 may add it.

- [ ] **Step 6: Rewire `Workspace` to the new sidebar**

In `client/src/components/Workspace.tsx`, replace the `Rail`/`GearPanel` imports and the rail + aside block (`lines 51-75`) so the left column is always present:

```tsx
import { Sidebar, type SidebarTab } from "./Sidebar";
import { HostPanel } from "./HostPanel";
```

```tsx
  const [tab, setTab] = useState<SidebarTab>("sessions");
```

```tsx
  return (
    <div className="flex h-screen">
      <div className="w-[272px] shrink-0 border-r border-line">
        <Sidebar active={tab} onSelect={setTab}>
          {tab === "sessions" && (
            <SessionsPanel
              agentBase={agentBase}
              tabs={chat.store.tabs}
              onOpen={(m) => void chat.openSession({ id: m.id, title: m.title })}
              onNew={() => chat.newDraft()}
            />
          )}
          {tab === "map" && (
            <OntologyPanel
              agentBase={agentBase}
              surfaceTabs={surfTabs}
              activeSurfaceId={activeSurf}
              onSelectSurface={setActiveSurf}
            />
          )}
          {tab === "host" && (
            <HostPanel agentBase={agentBase} dashboardBase={dashboardBase} onDisconnect={onDisconnect} />
          )}
        </Sidebar>
      </div>
      {/* chat + canvas columns unchanged for now — Task 13 replaces this wrapper */}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-w-64 w-2/5 max-w-[70%] resize-x flex-col overflow-hidden border-r border-line">
          <ChatTabs
            tabs={chat.store.tabs}
            activeKey={chat.store.activeKey}
            onFocus={chat.focus}
            onClose={chat.close}
          />
          {active ? (
            <AgentPanel
              tab={active}
              slashCommands={active.agent.slashCommands}
              onSend={(text, files) => chat.send(active.key, text, files)}
            />
          ) : (
            <p className="m-auto text-sm text-muted">Open a session or start a new one.</p>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <Canvas dashboardBase={dashboardBase} tabs={surfTabs} activeId={activeSurf} onSelect={setActiveSurf} />
        </div>
      </div>
    </div>
  );
```

Delete `client/src/components/Rail.tsx` and `client/src/components/GearPanel.tsx`.

- [ ] **Step 7: Update the Workspace test**

In `client/test/Workspace.test.tsx`, replace the two rail-based tests (currently the first two in the `Workspace shell` describe) with:

```tsx
  it("renders the sidebar tabs", () => {
    setup();
    expect(screen.getByRole("tab", { name: "SESSIONS" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "MAP" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "HOST" })).toBeTruthy();
  });

  it("host tab shows both hosts and Disconnect works", async () => {
    const { onDisconnect } = setup();
    await userEvent.click(screen.getByRole("tab", { name: "HOST" }));
    expect(screen.getByText("http://a:8787")).toBeTruthy();
    expect(screen.getByText("http://d:8788")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "DISCONNECT" }));
    expect(onDisconnect).toHaveBeenCalled();
  });
```

Read the rest of that file and fix any other assertion that names a rail button (`"Sessions"`, `"System map"`, `"Connection"`) or that depends on the aside collapsing — the sidebar no longer collapses, so a test asserting a second click hides the panel must be deleted rather than adapted.

- [ ] **Step 8: Run the suite and typecheck**

Run: `cd client && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add -A client/src/components client/test/Workspace.test.tsx client/test/Sidebar.test.tsx
git commit -m "feat(client): replace the icon rail with a tabbed sidebar

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Sessions panel — search, grouping, two-line rows

**Files:**
- Modify: `client/src/components/SessionsPanel.tsx` (full rewrite of the render body; keep `refresh`, `submitRename`, `archive` intact)
- Test: modify `client/test/SessionsPanel.test.tsx`

**Interfaces:**
- Consumes: `SidebarTab` layout from Task 2 (panel body fills the column)
- Produces: unchanged props — `{ agentBase, tabs, onOpen, onNew }`. Adds an exported pure helper `groupSessions(list: SessionMeta[], now: number): { label: string; items: SessionMeta[] }[]` for testing.

- [ ] **Step 1: Write the failing test for grouping**

```tsx
// append to client/test/SessionsPanel.test.tsx
import { groupSessions } from "../src/components/SessionsPanel";

describe("groupSessions", () => {
  const now = Date.parse("2026-08-10T12:00:00.000Z");
  const at = (iso: string) => ({
    id: iso, title: iso, createdAt: iso, lastActiveAt: iso, preview: "", archived: false,
  });

  it("buckets by age and drops empty buckets", () => {
    const groups = groupSessions(
      [at("2026-08-10T11:00:00.000Z"), at("2026-08-06T11:00:00.000Z")],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(["Today", "Previous 7 days"]);
  });

  it("puts anything older than 30 days in the last bucket", () => {
    const groups = groupSessions([at("2026-05-01T11:00:00.000Z")], now);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Previous 30 days");
  });

  it("keeps host order within a bucket", () => {
    const groups = groupSessions(
      [at("2026-08-10T09:00:00.000Z"), at("2026-08-10T11:00:00.000Z")],
      now,
    );
    expect(groups[0].items.map((s) => s.id)).toEqual([
      "2026-08-10T09:00:00.000Z",
      "2026-08-10T11:00:00.000Z",
    ]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && npx vitest run test/SessionsPanel.test.tsx`
Expected: FAIL — `groupSessions` is not exported

- [ ] **Step 3: Implement `groupSessions` and the new render body**

Add above the component in `client/src/components/SessionsPanel.tsx`:

```tsx
const DAY_MS = 86400000;

// Three fixed buckets, matching the design. "Previous 30 days" is the tail
// bucket and takes everything older too — the host already excludes archived
// sessions, so an unbounded tail is the honest place for them.
export function groupSessions(
  list: SessionMeta[],
  now: number,
): { label: string; items: SessionMeta[] }[] {
  const buckets: { label: string; items: SessionMeta[] }[] = [
    { label: "Today", items: [] },
    { label: "Previous 7 days", items: [] },
    { label: "Previous 30 days", items: [] },
  ];
  for (const s of list) {
    const age = now - Date.parse(s.lastActiveAt);
    const i = age < DAY_MS ? 0 : age < 7 * DAY_MS ? 1 : 2;
    buckets[i].items.push(s);
  }
  return buckets.filter((b) => b.items.length > 0);
}
```

Add a query to component state and replace the returned JSX:

```tsx
  const [query, setQuery] = useState("");
```

```tsx
  const q = query.trim().toLowerCase();
  const filtered = q
    ? sessions.filter((s) => s.title.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q))
    : sessions;
  const groups = groupSessions(filtered, Date.now());

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none flex-col gap-2 px-4 pb-3">
        <div className="flex items-center gap-2 border border-line-strong bg-bg px-2.5 py-2">
          <span className="mn text-faint" aria-hidden>⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search sessions"
            placeholder="Search sessions…"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint"
          />
        </div>
        <div className="flex items-center gap-2.5">
          <span className="mn text-faint">
            {q ? `${filtered.length} of ${sessions.length} match` : `${sessions.length} sessions`}
          </span>
          <span className="flex-1" />
          <button onClick={onNew} className="mn text-accent">+ NEW</button>
        </div>
      </div>
      {error && <p className="px-4 pb-2 text-xs text-danger">Couldn't load sessions — retrying…</p>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="px-4 pb-1.5 pt-2.5"><span className="ey">{g.label}</span></div>
            <ul>
              {g.items.map((s) => {
                const tab = tabs.find((t) => t.key === s.id);
                return (
                  <li key={s.id} className="group relative">
                    {renaming === s.id ? (
                      <input
                        autoFocus
                        value={draftTitle}
                        onChange={(e) => setDraftTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void submitRename(s.id);
                          if (e.key === "Escape") setRenaming(null);
                        }}
                        onBlur={() => setRenaming(null)}
                        className="w-full border border-accent bg-raised px-4 py-2 text-[13px] outline-none"
                      />
                    ) : (
                      <button
                        onClick={() => onOpen(s)}
                        className="flex w-full items-center gap-2.5 border-l-2 border-transparent px-4 py-2.5 text-left hover:bg-raised"
                      >
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate text-[13px] text-muted">{s.title}</span>
                          <span className="truncate text-[11.5px] text-faint">{s.preview}</span>
                        </span>
                        {tab && tab.openTurns > 0 && (
                          <span aria-label={`${s.id} running`} className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" />
                        )}
                        {tab?.unread && (
                          <span aria-label={`${s.id} unread`} className="h-2 w-2 shrink-0 rounded-full border border-accent" />
                        )}
                        <span className="mn shrink-0 text-faint">{relTime(s.lastActiveAt)}</span>
                      </button>
                    )}
                    {renaming !== s.id && (
                      <span className="absolute right-2 top-2 hidden gap-1 group-hover:flex">
                        <button
                          aria-label={`Rename ${s.title}`}
                          onClick={() => { setRenaming(s.id); setDraftTitle(s.title); }}
                          className="bg-raised px-1 text-xs text-muted hover:text-ink"
                        >
                          ✎
                        </button>
                        <button
                          aria-label={`Archive ${s.title}`}
                          onClick={() => void archive(s.id)}
                          className="bg-raised px-1 text-xs text-muted hover:text-danger"
                        >
                          🗄
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {sessions.length === 0 && (
          <p className="px-4 py-5 text-xs text-faint">No sessions yet.</p>
        )}
        {sessions.length > 0 && filtered.length === 0 && (
          <p className="px-4 py-5 text-[12.5px] text-faint">No session matches that.</p>
        )}
      </div>
    </div>
  );
```

The active-session highlight the mock shows (accent left rule, `open` in place of the timestamp) is not applied here: `SessionsPanel` receives `tabs` but not `activeKey`. Wiring that through is Task 13, which owns the `Workspace` rewrite.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd client && npx vitest run test/SessionsPanel.test.tsx`
Expected: PASS. If an existing assertion targets `New session`, change it to `+ NEW`; if one targets a flat `<ul>` of every session, it still passes since rows keep their `onOpen` buttons.

- [ ] **Step 5: Add a search test**

```tsx
// append to client/test/SessionsPanel.test.tsx, inside the component describe
  it("filters the list and reports the match count", async () => {
    // uses the file's existing listSessions mock; ensure it resolves at least
    // two sessions with distinct titles before running this
    render(<SessionsPanel agentBase="http://a" tabs={[]} onOpen={vi.fn()} onNew={vi.fn()} />);
    await screen.findByText(/sessions$/);
    await userEvent.type(screen.getByLabelText("Search sessions"), "zzzznomatch");
    expect(screen.getByText("No session matches that.")).toBeTruthy();
  });
```

- [ ] **Step 6: Run the suite and typecheck**

Run: `cd client && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add client/src/components/SessionsPanel.tsx client/test/SessionsPanel.test.tsx
git commit -m "feat(client): search, date grouping, and previews in the sessions panel

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: MAP panel — flat indented tree with node selection

The mock's MAP is a single indented list, not the current type-grouped sections, and selecting a non-dashboard node shows its detail in the *right* pane rather than expanding inline.

**Files:**
- Modify: `client/src/components/OntologyPanel.tsx` (full render rewrite; drop the inline `expanded` state)
- Modify: `client/src/lib/ontologyStore.ts` (add `flattenNodes`, keep `filterNodes` and `registryIdFor`; `groupNodes` becomes unused — delete it and its tests)
- Test: modify `client/test/ontologyStore.test.ts`, `client/test/OntologyPanel.test.tsx`

**Interfaces:**
- Consumes: `filterNodes`, `registryIdFor` (existing)
- Produces: `flattenNodes(nodes: OntologyNode[]): { node: OntologyNode; depth: number }[]`; `OntologyPanel` gains a required prop `onSelectNode: (nodeId: string) => void` and `selectedNodeId: string | null`

- [ ] **Step 1: Write the failing test for `flattenNodes`**

```ts
// client/test/ontologyStore.test.ts — replace the groupNodes describe with this
import { flattenNodes } from "../src/lib/ontologyStore";
import type { OntologyNode } from "../src/lib/types";

const n = (id: string, type: string, rels: string[] = []): OntologyNode => ({
  type, id, title: id, managed: "system", props: {},
  relationships: rels.map((target) => ({ edge: "uses", target })),
});

describe("flattenNodes", () => {
  it("puts dashboards at depth 0 with their dependencies nested under them", () => {
    const out = flattenNodes([
      n("dashboard-farm", "dashboard", ["service-api"]),
      n("service-api", "service", ["container-118"]),
      n("container-118", "container"),
    ]);
    expect(out.map((r) => [r.node.id, r.depth])).toEqual([
      ["dashboard-farm", 0],
      ["service-api", 1],
      ["container-118", 2],
    ]);
  });

  it("lists nodes no dashboard reaches at depth 0, after the dashboards", () => {
    const out = flattenNodes([
      n("dashboard-farm", "dashboard"),
      n("vm-nuc", "vm"),
    ]);
    expect(out.map((r) => [r.node.id, r.depth])).toEqual([
      ["dashboard-farm", 0],
      ["vm-nuc", 0],
    ]);
  });

  it("emits each node once even when two dashboards share a dependency", () => {
    const out = flattenNodes([
      n("dashboard-a", "dashboard", ["datasource-pg"]),
      n("dashboard-b", "dashboard", ["datasource-pg"]),
      n("datasource-pg", "datasource"),
    ]);
    expect(out.filter((r) => r.node.id === "datasource-pg")).toHaveLength(1);
  });

  it("terminates on a relationship cycle", () => {
    const out = flattenNodes([
      n("dashboard-a", "dashboard", ["service-x"]),
      n("service-x", "service", ["dashboard-a"]),
    ]);
    expect(out).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && npx vitest run test/ontologyStore.test.ts`
Expected: FAIL — `flattenNodes` is not exported

- [ ] **Step 3: Implement `flattenNodes`, delete `groupNodes`**

In `client/src/lib/ontologyStore.ts`, remove the `SECTIONS` const, `DOMAIN_LABEL`, and `groupNodes`, then add:

```ts
// Relationship targets are written by the agent and may be an id or a title,
// so resolve on either. An unresolvable target is simply not a tree edge.
function resolve(nodes: OntologyNode[], target: string): OntologyNode | undefined {
  return nodes.find((n) => n.id === target) ?? nodes.find((n) => n.title === target);
}

// Dashboards are the roots — they are the things an operator opens. Everything
// they depend on nests beneath them; whatever no dashboard reaches is listed
// flat afterwards, which is how an orphaned host shows up at all.
export function flattenNodes(nodes: OntologyNode[]): { node: OntologyNode; depth: number }[] {
  const out: { node: OntologyNode; depth: number }[] = [];
  const emitted = new Set<string>();

  function walk(node: OntologyNode, depth: number, seen: Set<string>) {
    if (emitted.has(node.id) || seen.has(node.id) || depth > 6) return;
    emitted.add(node.id);
    out.push({ node, depth });
    const next = new Set(seen).add(node.id);
    for (const rel of node.relationships) {
      const child = resolve(nodes, rel.target);
      if (child) walk(child, depth + 1, next);
    }
  }

  for (const node of nodes.filter((n) => n.type === "dashboard")) walk(node, 0, new Set());
  for (const node of nodes) if (!emitted.has(node.id)) walk(node, 0, new Set());
  return out;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd client && npx vitest run test/ontologyStore.test.ts`
Expected: PASS

- [ ] **Step 5: Rewrite the `OntologyPanel` render**

Replace the component's props and returned JSX in `client/src/components/OntologyPanel.tsx` (keep the `load`/`useEffect`/`snap`/`fetchError` logic exactly as it is; delete the `expanded` state and the `row` helper):

```tsx
export function OntologyPanel({
  agentBase,
  surfaceTabs,
  activeSurfaceId,
  selectedNodeId,
  onSelectSurface,
  onSelectNode,
}: {
  agentBase: string;
  surfaceTabs: Tab[];
  activeSurfaceId: string | null;
  selectedNodeId: string | null;
  onSelectSurface: (id: string) => void;
  onSelectNode: (nodeId: string) => void;
}) {
```

```tsx
  const error = fetchError ?? snap?.syncError ?? null;
  const rows = snap ? flattenNodes(filterNodes(snap.nodes, query)) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none px-4 pb-3">
        <div className="flex items-center gap-2 border border-line-strong bg-bg px-2.5 py-2">
          <span className="mn text-faint" aria-hidden>⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter nodes"
            placeholder={snap ? `Filter ${snap.nodes.length} nodes…` : "Filter…"}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint"
          />
        </div>
      </div>
      {error && (
        <p className="mx-4 mb-2 border border-line bg-raised px-2 py-1 text-xs text-muted">sync problem: {error}</p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {rows.map(({ node, depth }) => {
          const rid = registryIdFor(node);
          const live = rid !== null && surfaceTabs.some((t) => t.id === rid);
          const selected = rid !== null ? rid === activeSurfaceId : node.id === selectedNodeId;
          return (
            <button
              key={node.id}
              onClick={() => (rid !== null && live ? onSelectSurface(rid) : onSelectNode(node.id))}
              aria-current={selected ? "true" : undefined}
              style={{ paddingLeft: `${16 + depth * 16}px` }}
              className={
                selected
                  ? "flex w-full items-center gap-2.5 border-l-2 border-accent bg-raised py-1.5 pr-4 text-left"
                  : "flex w-full items-center gap-2.5 border-l-2 border-transparent py-1.5 pr-4 text-left hover:bg-raised"
              }
            >
              <span className="mn text-line-strong" aria-hidden>{depth === 0 ? "" : "└"}</span>
              <span
                className={
                  selected
                    ? "min-w-0 flex-1 truncate text-[12.5px] text-ink"
                    : "min-w-0 flex-1 truncate text-[12.5px] text-muted"
                }
              >
                {node.title}
              </span>
              <span className="mn shrink-0 text-faint">{rid !== null && !live ? "—" : node.type}</span>
            </button>
          );
        })}
        {snap && rows.length === 0 && (
          <p className="px-4 py-5 text-xs text-faint">Nothing on the map yet.</p>
        )}
      </div>
    </div>
  );
```

Update the import line to `import { flattenNodes, filterNodes, registryIdFor } from "../lib/ontologyStore";` and drop the now-unused `OntologyNode` type import if TypeScript flags it.

A dashboard node whose surface is not in the registry shows `—` and falls through to `onSelectNode`, so it opens its detail rather than being a dead disabled row.

- [ ] **Step 6: Update the panel test**

In `client/test/OntologyPanel.test.tsx`, add the two new required props to every `render(...)` call (`selectedNodeId={null}` and `onSelectNode={vi.fn()}`), replace any assertion on section headings (`"Dashboards"`, `"Services"`, …) with assertions on node titles, and add:

```tsx
  it("routes a non-dashboard node to onSelectNode", async () => {
    const onSelectNode = vi.fn();
    // the file's getOntology mock must include a non-dashboard node; add
    // { type: "service", id: "service-api", title: "printer-api", managed: "system", props: {}, relationships: [] }
    render(
      <OntologyPanel
        agentBase="http://a"
        surfaceTabs={[]}
        activeSurfaceId={null}
        selectedNodeId={null}
        onSelectSurface={vi.fn()}
        onSelectNode={onSelectNode}
      />,
    );
    await userEvent.click(await screen.findByText("printer-api"));
    expect(onSelectNode).toHaveBeenCalledWith("service-api");
  });
```

- [ ] **Step 7: Pass the new props from `Workspace`**

In `client/src/components/Workspace.tsx`, add `const [selectedNode, setSelectedNode] = useState<string | null>(null);` and pass `selectedNodeId={selectedNode}` plus `onSelectNode={setSelectedNode}` to `OntologyPanel`. Selecting a surface should clear the node: change the surface handler to `onSelectSurface={(id) => { setActiveSurf(id); setSelectedNode(null); }}`.

- [ ] **Step 8: Run the suite and typecheck**

Run: `cd client && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add client/src/lib/ontologyStore.ts client/src/components/OntologyPanel.tsx client/src/components/Workspace.tsx client/test/ontologyStore.test.ts client/test/OntologyPanel.test.tsx
git commit -m "feat(client): flat indented map tree with node selection

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Lineage breadcrumb

**Files:**
- Create: `client/src/lib/lineage.ts`
- Test: `client/test/lineage.test.ts`

**Interfaces:**
- Consumes: `OntologyNode` from `src/lib/types.ts`
- Produces: `buildLineage(nodes: OntologyNode[], nodeId: string): string[]` — deepest dependency first, the node itself last

- [ ] **Step 1: Write the failing test**

```ts
// client/test/lineage.test.ts
import { describe, it, expect } from "vitest";
import { buildLineage } from "../src/lib/lineage";
import type { OntologyNode } from "../src/lib/types";

const n = (id: string, title: string, rels: string[] = []): OntologyNode => ({
  type: "service", id, title, managed: "system", props: {},
  relationships: rels.map((target) => ({ edge: "uses", target })),
});

describe("buildLineage", () => {
  it("walks dependencies and returns them deepest-first with the node last", () => {
    const nodes = [
      n("dashboard-farm", "printer-farm", ["service-api"]),
      n("service-api", "printer-api", ["container-118"]),
      n("container-118", "LXC 118"),
    ];
    expect(buildLineage(nodes, "dashboard-farm")).toEqual(["LXC 118", "printer-api", "printer-farm"]);
  });

  it("resolves a relationship target given as a title", () => {
    const nodes = [n("dashboard-farm", "printer-farm", ["printer-api"]), n("service-api", "printer-api")];
    expect(buildLineage(nodes, "dashboard-farm")).toEqual(["printer-api", "printer-farm"]);
  });

  it("returns just the node when it has no resolvable dependencies", () => {
    expect(buildLineage([n("vm-nuc", "pve · nuc-02", ["gone"])], "vm-nuc")).toEqual(["pve · nuc-02"]);
  });

  it("returns an empty array for an unknown node", () => {
    expect(buildLineage([n("a", "A")], "missing")).toEqual([]);
  });

  it("stops on a cycle instead of looping", () => {
    const nodes = [n("a", "A", ["b"]), n("b", "B", ["a"])];
    expect(buildLineage(nodes, "a")).toEqual(["B", "A"]);
  });

  it("caps the chain at four labels, keeping the node itself", () => {
    const nodes = [
      n("a", "A", ["b"]), n("b", "B", ["c"]), n("c", "C", ["d"]),
      n("d", "D", ["e"]), n("e", "E"),
    ];
    const out = buildLineage(nodes, "a");
    expect(out).toHaveLength(4);
    expect(out[out.length - 1]).toBe("A");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && npx vitest run test/lineage.test.ts`
Expected: FAIL — cannot resolve `../src/lib/lineage`

- [ ] **Step 3: Implement `buildLineage`**

```ts
// client/src/lib/lineage.ts
import type { OntologyNode } from "./types";

const MAX_LABELS = 4;

function resolve(nodes: OntologyNode[], target: string): OntologyNode | undefined {
  return nodes.find((n) => n.id === target) ?? nodes.find((n) => n.title === target);
}

// The breadcrumb reads bottom-up: the thing everything rests on, through to
// the surface itself. Follows the FIRST resolvable relationship at each hop —
// a node with several dependencies has no single lineage, and picking one is
// better than rendering a graph in a 40px strip.
export function buildLineage(nodes: OntologyNode[], nodeId: string): string[] {
  const start = nodes.find((n) => n.id === nodeId);
  if (!start) return [];
  const chain: string[] = [start.title];
  const seen = new Set<string>([start.id]);
  let cur = start;
  while (chain.length < MAX_LABELS) {
    let next: OntologyNode | undefined;
    for (const rel of cur.relationships) {
      const cand = resolve(nodes, rel.target);
      if (cand && !seen.has(cand.id)) {
        next = cand;
        break;
      }
    }
    if (!next) break;
    seen.add(next.id);
    chain.push(next.title);
    cur = next;
  }
  return chain.reverse();
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd client && npx vitest run test/lineage.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/lineage.ts client/test/lineage.test.ts
git commit -m "feat(client): derive a surface lineage breadcrumb from the ontology

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Surface frame — lineage header, detach, iframe body

**Files:**
- Create: `client/src/components/SurfaceFrame.tsx`
- Modify: `client/src/components/Canvas.tsx` (strip the tab strip and detach button; it becomes the body only)
- Test: `client/test/SurfaceFrame.test.tsx`; modify `client/test/Canvas.test.tsx`

**Interfaces:**
- Consumes: `buildLineage` (Task 5), `Tab` from `src/lib/registryStore.ts`
- Produces: `<SurfaceFrame lineage={string[]} onDetach={() => void} detachError={boolean}>{body}</SurfaceFrame>`; `Canvas` prop shape narrows to `{ dashboardBase, active: Tab | null }`

- [ ] **Step 1: Write the failing test**

```tsx
// client/test/SurfaceFrame.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SurfaceFrame } from "../src/components/SurfaceFrame";

describe("SurfaceFrame", () => {
  it("renders each lineage label with arrows between but not after", () => {
    render(
      <SurfaceFrame lineage={["pg printers", "printer-api", "printer-farm"]} onDetach={vi.fn()} detachError={false}>
        <p>body</p>
      </SurfaceFrame>,
    );
    expect(screen.getByText("pg printers")).toBeTruthy();
    expect(screen.getByText("printer-farm")).toBeTruthy();
    expect(screen.getAllByText("→")).toHaveLength(2);
  });

  it("renders the body", () => {
    render(
      <SurfaceFrame lineage={[]} onDetach={vi.fn()} detachError={false}>
        <p>body</p>
      </SurfaceFrame>,
    );
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("calls onDetach", async () => {
    const onDetach = vi.fn();
    render(
      <SurfaceFrame lineage={["x"]} onDetach={onDetach} detachError={false}>
        <p>body</p>
      </SurfaceFrame>,
    );
    await userEvent.click(screen.getByRole("button", { name: /DETACH/ }));
    expect(onDetach).toHaveBeenCalled();
  });

  it("surfaces a detach failure", () => {
    render(
      <SurfaceFrame lineage={["x"]} onDetach={vi.fn()} detachError>
        <p>body</p>
      </SurfaceFrame>,
    );
    expect(screen.getByText("Detach failed")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && npx vitest run test/SurfaceFrame.test.tsx`
Expected: FAIL — cannot resolve `../src/components/SurfaceFrame`

- [ ] **Step 3: Implement `SurfaceFrame`**

```tsx
// client/src/components/SurfaceFrame.tsx
export function SurfaceFrame({
  lineage,
  onDetach,
  detachError,
  children,
}: {
  lineage: string[];
  onDetach: () => void;
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
        <button onClick={onDetach} className="mn shrink-0 whitespace-nowrap text-muted hover:text-ink">
          DETACH ↗
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
```

The mock's capability badge (`read-write`, `read-only`) is intentionally not here — see Global Constraints and Task 15.

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd client && npx vitest run test/SurfaceFrame.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Reduce `Canvas` to a body**

Replace `client/src/components/Canvas.tsx` entirely:

```tsx
// client/src/components/Canvas.tsx
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
```

Move `detach()` — including its full comment block from the old `Canvas.tsx:22-26` — into `Workspace.tsx`, since `Workspace` now owns `detachError` and hands `onDetach` to `SurfaceFrame`:

```tsx
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
```

```tsx
  const [detachError, setDetachError] = useState(false);

  function detach() {
    const active = surfTabs.find((t) => t.id === activeSurf);
    if (!active) return;
    // The detached surface loads untrusted agent-built content. It is labeled
    // `surface:<id>`, which intentionally matches NO capability in
    // src-tauri/capabilities/default.json (that capability is scoped to
    // `"windows": ["main"]`), so this window inherits no Tauri IPC/command
    // access. Do not add a capability whose `windows` matches `surface:*`.
    const w = new WebviewWindow(`surface:${active.id}`, {
      url: `${dashboardBase}${active.url}`,
      title: active.title,
    });
    void w.once("tauri://created", () => setDetachError(false));
    void w.once("tauri://error", () => setDetachError(true));
  }
```

Wrap the canvas column in `Workspace` with the frame:

```tsx
        <div className="min-w-0 flex-1">
          <SurfaceFrame
            lineage={activeSurf ? buildLineage(ontologyNodes, `dashboard-${activeSurf}`) : []}
            onDetach={detach}
            detachError={detachError}
          >
            <Canvas dashboardBase={dashboardBase} active={surfTabs.find((t) => t.id === activeSurf) ?? null} />
          </SurfaceFrame>
        </div>
```

`Workspace` needs the ontology nodes for the breadcrumb. Add to `Workspace`:

```tsx
  const [ontologyNodes, setOntologyNodes] = useState<OntologyNode[]>([]);

  useEffect(() => {
    getOntology(agentBase)
      .then((s) => setOntologyNodes(s.nodes))
      .catch(() => setOntologyNodes([])); // breadcrumb degrades to empty; the map panel reports the error
  }, [agentBase]);
```

This is a second `getOntology` call alongside `OntologyPanel`'s. That duplication is accepted here to keep the task self-contained; Task 13 lifts the fetch into `Workspace` and passes the snapshot down.

- [ ] **Step 6: Update the Canvas test**

Rewrite `client/test/Canvas.test.tsx` for the narrowed props: drop the tab-strip and detach assertions (now covered by `SurfaceFrame.test.tsx` and `Workspace.test.tsx`), keep an assertion that the iframe `src` concatenates `dashboardBase + url` and that `sandbox` is exactly `allow-scripts allow-same-origin`, and keep the empty-state test.

- [ ] **Step 7: Run the suite and typecheck**

Run: `cd client && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add client/src/components/SurfaceFrame.tsx client/src/components/Canvas.tsx client/src/components/Workspace.tsx client/test/SurfaceFrame.test.tsx client/test/Canvas.test.tsx
git commit -m "feat(client): surface frame with lineage breadcrumb and detach

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Node detail in the surface pane

Selecting a non-dashboard map node replaces the iframe with the node's properties and edges — the mock's "ontology node" state.

**Files:**
- Create: `client/src/components/NodeDetail.tsx`
- Modify: `client/src/components/Workspace.tsx`
- Test: `client/test/NodeDetail.test.tsx`

**Interfaces:**
- Consumes: `OntologyNode`
- Produces: `<NodeDetail node={OntologyNode} />`

- [ ] **Step 1: Write the failing test**

```tsx
// client/test/NodeDetail.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NodeDetail } from "../src/components/NodeDetail";
import type { OntologyNode } from "../src/lib/types";

const node: OntologyNode = {
  type: "service",
  id: "service-api",
  title: "printer-api",
  managed: "system",
  props: { container: "LXC 118", p95: "38 ms" },
  relationships: [{ edge: "serves", target: "printer-farm" }],
};

describe("NodeDetail", () => {
  it("shows the type, title, props, and edges", () => {
    render(<NodeDetail node={node} />);
    expect(screen.getByText("service")).toBeTruthy();
    expect(screen.getByText("printer-api")).toBeTruthy();
    expect(screen.getByText("container")).toBeTruthy();
    expect(screen.getByText("LXC 118")).toBeTruthy();
    expect(screen.getByText("serves")).toBeTruthy();
    expect(screen.getByText("printer-farm")).toBeTruthy();
  });

  it("explains a node with no edges rather than showing an empty section", () => {
    render(<NodeDetail node={{ ...node, relationships: [] }} />);
    expect(screen.getByText(/nothing depends on it/i)).toBeTruthy();
  });

  it("renders without props", () => {
    render(<NodeDetail node={{ ...node, props: {} }} />);
    expect(screen.getByText("printer-api")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && npx vitest run test/NodeDetail.test.tsx`
Expected: FAIL — cannot resolve `../src/components/NodeDetail`

- [ ] **Step 3: Implement `NodeDetail`**

```tsx
// client/src/components/NodeDetail.tsx
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
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd client && npx vitest run test/NodeDetail.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Route node selection into the surface pane**

In `Workspace.tsx`, derive the pane body and its breadcrumb from whichever of the two selections is live:

```tsx
  const selected = selectedNode ? ontologyNodes.find((n) => n.id === selectedNode) ?? null : null;
  const activeSurface = surfTabs.find((t) => t.id === activeSurf) ?? null;
  const lineageId = selected ? selected.id : activeSurf ? `dashboard-${activeSurf}` : null;
```

```tsx
          <SurfaceFrame
            lineage={lineageId ? buildLineage(ontologyNodes, lineageId) : []}
            onDetach={detach}
            detachError={detachError}
          >
            {selected ? (
              <NodeDetail node={selected} />
            ) : (
              <Canvas dashboardBase={dashboardBase} active={activeSurface} />
            )}
          </SurfaceFrame>
```

Detach is meaningless for a node view — guard `detach()` with `if (selected) return;` at the top and hide the button by passing `onDetach` only when a surface is active. Simplest correct form: add an `onDetach?: () => void` prop to `SurfaceFrame` and render the button only when it is defined. Update `SurfaceFrame.test.tsx` with a case asserting the button is absent when `onDetach` is omitted.

- [ ] **Step 6: Run the suite and typecheck**

Run: `cd client && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add client/src/components/NodeDetail.tsx client/src/components/SurfaceFrame.tsx client/src/components/Workspace.tsx client/test/NodeDetail.test.tsx client/test/SurfaceFrame.test.tsx
git commit -m "feat(client): show ontology node detail in the surface pane

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Transcript restyle

**Files:**
- Modify: `client/src/components/Transcript.tsx:5-77`
- Test: modify `client/test/Transcript.test.tsx`

**Interfaces:**
- Consumes: `TranscriptMessage` (unchanged)
- Produces: no API change; `Transcript` keeps `{ messages, busy }` until Task 9 adds approvals

- [ ] **Step 1: Write the failing test**

```tsx
// append to client/test/Transcript.test.tsx
  it("caps agent prose at a readable measure", () => {
    render(<Transcript messages={[{ kind: "text", text: "hello" }]} busy={false} />);
    const el = screen.getByText("hello").closest("[data-kind='text']");
    expect(el?.className).toContain("max-w-[60ch]");
  });

  it("renders a result as a dotted status line, not a divider", () => {
    render(<Transcript messages={[{ kind: "result", text: "Idle" }]} busy={false} />);
    const el = screen.getByText("Idle").closest("[data-kind='result']");
    expect(el?.querySelector("[data-role='dot']")).toBeTruthy();
  });

  it("labels the busy indicator as Working", () => {
    render(<Transcript messages={[]} busy />);
    expect(screen.getByText("Working…")).toBeTruthy();
  });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && npx vitest run test/Transcript.test.tsx`
Expected: FAIL — `max-w-[60ch]` absent; no `data-role='dot'`; text is `thinking…`

- [ ] **Step 3: Restyle the message kinds**

Replace the `Message` component and the busy indicator in `client/src/components/Transcript.tsx`:

```tsx
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
```

And the `ToolChip`:

```tsx
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
```

Busy indicator:

```tsx
        {busy && (
          <div className="flex items-center gap-2.5">
            <span className="h-[5px] w-[5px] rounded-full bg-accent" />
            <span className="text-[12.5px] text-faint">Working…</span>
          </div>
        )}
```

Container padding and gap:

```tsx
        className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 pb-2.5 pt-7"
```

The mock's collapsed `"Rewrote the surface and added two endpoints · 7 steps, 21s"` line implies the client groups consecutive tool calls into a summary with a step count and duration. `TranscriptMessage` carries no timestamps and `reduceAgent` emits one message per `tool_use` block, so a truthful duration is not available. Tool chips therefore stay one-per-call, restyled to match. Adding timings would need an `AgentEvent` change — out of scope per Global Constraints.

Keep the scroll-latching logic (`stickToBottom`, `onUserScroll`, `jump`) exactly as it is. It is the fix for a known bug; do not refactor it.

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd client && npx vitest run test/Transcript.test.tsx`
Expected: PASS. Fix any existing assertion that matched `🔧` or `thinking…`.

- [ ] **Step 5: Run the suite and typecheck**

Run: `cd client && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add client/src/components/Transcript.tsx client/test/Transcript.test.tsx
git commit -m "feat(client): restyle transcript message kinds to the 5a design

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Approvals inline in the transcript

The headline change. `ConfirmationDialog` is deleted; its two streams move to `Workspace`, and pendings render as cards at the bottom of the active transcript, resolving in place.

Pendings carry no session id, so they cannot be attributed to a conversation. They render in the active tab's transcript and their resolved outcomes persist in `Workspace` state for the app's lifetime, not per-session. Do not fabricate an attribution.

**Files:**
- Create: `client/src/lib/opSummary.ts`, `client/src/components/ApprovalCard.tsx`
- Modify: `client/src/lib/pendingStore.ts`, `client/src/components/Transcript.tsx`, `client/src/components/AgentPanel.tsx`, `client/src/components/Workspace.tsx`, `client/src/App.tsx`
- Delete: `client/src/components/ConfirmationDialog.tsx`, `client/test/ConfirmationDialog.test.tsx`
- Test: `client/test/opSummary.test.ts`, `client/test/ApprovalCard.test.tsx`; modify `client/test/pendingStore.test.ts`

**Interfaces:**
- Consumes: `PendingItem`, `reducePending`, `resolvePending`, `resolveInfraPending`, `openPendingStream`, `openInfraPendingStream`
- Produces:
  - `summarizeOp(item: PendingItem): string`
  - `interface ResolvedItem { pendingId: string; summary: string; outcome: string }`
  - `<ApprovalCard item={PendingItem} onResolve={(d: "approve" | "deny", trust: boolean) => void} />`
  - `Transcript` gains `pending: PendingItem[]`, `resolved: ResolvedItem[]`, `onResolve: (item: PendingItem, d: "approve" | "deny", trust: boolean) => void`
  - `AgentPanel` forwards the same three props

- [ ] **Step 1: Write the failing test for `summarizeOp`**

```ts
// client/test/opSummary.test.ts
import { describe, it, expect } from "vitest";
import { summarizeOp } from "../src/lib/opSummary";
import type { PendingItem } from "../src/lib/pendingStore";

const data = (op: unknown, surfaceId: string | null = "printer-farm"): PendingItem => ({
  origin: "data", pendingId: "p1", source: "printers", op, surfaceId,
});

describe("summarizeOp", () => {
  it("describes an insert", () => {
    expect(summarizeOp(data({ kind: "insert", table: "jobs", values: { a: 1 } })))
      .toBe("Add a row to printers.jobs");
  });

  it("describes an update", () => {
    expect(summarizeOp(data({ kind: "update", table: "jobs", where: { id: 1 }, values: { material: "PLA" } })))
      .toBe("Update rows in printers.jobs");
  });

  it("calls out a delete plainly", () => {
    expect(summarizeOp(data({ kind: "delete", table: "jobs", where: { id: 1 } })))
      .toBe("Delete rows from printers.jobs");
  });

  it("falls back for an op shape it does not recognize", () => {
    expect(summarizeOp(data({ kind: "vacuum" }))).toBe("Write to printers");
  });

  it("describes an infra action by tool name", () => {
    expect(summarizeOp({ origin: "infra", pendingId: "p2", tool: "provision_container", op: {} }))
      .toBe("Run provision_container");
  });

  it("marks a watchdog proposal", () => {
    expect(summarizeOp({ origin: "infra", pendingId: "p3", tool: "grow_disk", op: {}, proposedBy: "watchdog" }))
      .toBe("Run grow_disk (proposed by the watchdog)");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && npx vitest run test/opSummary.test.ts`
Expected: FAIL — cannot resolve `../src/lib/opSummary`

- [ ] **Step 3: Implement `summarizeOp`**

```ts
// client/src/lib/opSummary.ts
import type { PendingItem } from "./pendingStore";

// One plain sentence for the approval card headline. Deliberately does NOT
// state a row count: the pending payload carries a WHERE clause, not a
// matched-row count, and guessing one would misrepresent the blast radius.
export function summarizeOp(item: PendingItem): string {
  if (item.origin === "infra") {
    const base = `Run ${item.tool ?? "an infrastructure action"}`;
    return item.proposedBy === "watchdog" ? `${base} (proposed by the watchdog)` : base;
  }
  const source = item.source ?? "the data source";
  const op = item.op as { kind?: string; table?: string } | null;
  if (!op || typeof op.kind !== "string" || typeof op.table !== "string") {
    return `Write to ${source}`;
  }
  const target = `${source}.${op.table}`;
  switch (op.kind) {
    case "insert": return `Add a row to ${target}`;
    case "update": return `Update rows in ${target}`;
    case "delete": return `Delete rows from ${target}`;
    default: return `Write to ${source}`;
  }
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd client && npx vitest run test/opSummary.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Add `ResolvedItem` to the pending store**

Append to `client/src/lib/pendingStore.ts`:

```ts
export interface ResolvedItem {
  pendingId: string;
  summary: string;
  outcome: string;
}
```

- [ ] **Step 6: Write the failing test for `ApprovalCard`**

```tsx
// client/test/ApprovalCard.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalCard } from "../src/components/ApprovalCard";
import type { PendingItem } from "../src/lib/pendingStore";

const write: PendingItem = {
  origin: "data", pendingId: "p1", source: "printers",
  op: { kind: "update", table: "jobs", where: { id: 1 }, values: { material: "PLA" } },
  surfaceId: "printer-farm",
};

const del: PendingItem = { ...write, pendingId: "p2", op: { kind: "delete", table: "jobs", where: { id: 1 } } };
const infra: PendingItem = { origin: "infra", pendingId: "p3", tool: "grow_disk", op: { size: "8G" } };

describe("ApprovalCard", () => {
  it("shows the summary and the guardrail note for a data write", () => {
    render(<ApprovalCard item={write} onResolve={vi.fn()} />);
    expect(screen.getByText("Update rows in printers.jobs")).toBeTruthy();
    expect(screen.getByText(/printer-farm/)).toBeTruthy();
  });

  it("approves without trust by default", async () => {
    const onResolve = vi.fn();
    render(<ApprovalCard item={write} onResolve={onResolve} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onResolve).toHaveBeenCalledWith("approve", false);
  });

  it("passes the trust flag when the box is checked", async () => {
    const onResolve = vi.fn();
    render(<ApprovalCard item={write} onResolve={onResolve} />);
    await userEvent.click(screen.getByLabelText(/Trust this surface/));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onResolve).toHaveBeenCalledWith("approve", true);
  });

  it("denies", async () => {
    const onResolve = vi.fn();
    render(<ApprovalCard item={write} onResolve={onResolve} />);
    await userEvent.click(screen.getByRole("button", { name: "Not yet" }));
    expect(onResolve).toHaveBeenCalledWith("deny", false);
  });

  it("warns that a delete is not covered by trust", () => {
    render(<ApprovalCard item={del} onResolve={vi.fn()} />);
    expect(screen.getByText(/deletions always come back for approval/i)).toBeTruthy();
  });

  it("offers no trust option for an infra action", () => {
    render(<ApprovalCard item={infra} onResolve={vi.fn()} />);
    expect(screen.queryByLabelText(/Trust this surface/)).toBeNull();
  });

  it("exposes the raw op for inspection", async () => {
    render(<ApprovalCard item={write} onResolve={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /details/i }));
    expect(screen.getByText(/"table": "jobs"/)).toBeTruthy();
  });
});
```

- [ ] **Step 7: Run it and confirm it fails**

Run: `cd client && npx vitest run test/ApprovalCard.test.tsx`
Expected: FAIL — cannot resolve `../src/components/ApprovalCard`

- [ ] **Step 8: Implement `ApprovalCard`**

```tsx
// client/src/components/ApprovalCard.tsx
import { useState } from "react";
import type { PendingItem } from "../lib/pendingStore";
import { summarizeOp } from "../lib/opSummary";

function isDelete(item: PendingItem): boolean {
  return item.origin === "data" && (item.op as { kind?: string } | null)?.kind === "delete";
}

export function ApprovalCard({
  item,
  onResolve,
}: {
  item: PendingItem;
  onResolve: (decision: "approve" | "deny", trust: boolean) => void;
}) {
  const [trust, setTrust] = useState(false);
  const [open, setOpen] = useState(false);
  const trustable = item.origin === "data" && !!item.surfaceId && !isDelete(item);

  return (
    <div className="flex max-w-[60ch] flex-col gap-3.5 border-l border-warn pl-3.5">
      <div className="text-[14.5px] leading-[1.75] text-ink-soft">{summarizeOp(item)}</div>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="self-start text-left text-[12.5px] text-faint">
        <span className="border-b border-line-strong text-muted">{open ? "hide details" : "details"}</span>
      </button>
      {open && (
        <pre className="max-h-56 overflow-auto border border-line bg-panel p-2 font-mono text-xs text-muted">
          {JSON.stringify(item.op ?? null, null, 2)}
        </pre>
      )}
      {trustable && (
        <label className="flex items-center gap-2 text-[12.5px] text-muted">
          <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
          Trust this surface — future adds and edits from it run without asking
        </label>
      )}
      {isDelete(item) && (
        <span className="text-[12.5px] leading-relaxed text-warn">
          Deletions always come back for approval, even on a trusted surface.
        </span>
      )}
      <div className="flex flex-wrap items-center gap-3.5">
        <button
          onClick={() => onResolve("approve", trust)}
          className="flex-none whitespace-nowrap rounded-sm bg-accent px-4 py-2.5 text-[13px] text-bg"
        >
          Approve
        </button>
        <button
          onClick={() => onResolve("deny", false)}
          className="flex-none whitespace-nowrap rounded-sm border border-line-strong px-4 py-2.5 text-[13px] text-muted"
        >
          Not yet
        </button>
        <span className="min-w-0 flex-1 text-[12.5px] text-faint">
          {item.origin === "data"
            ? `guardrail: ${item.surfaceId ?? "unattributed surface"} · ${item.source ?? "unknown source"}`
            : "runs on the box once approved"}
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 9: Run it and confirm it passes**

Run: `cd client && npx vitest run test/ApprovalCard.test.tsx`
Expected: PASS (7 tests)

- [ ] **Step 10: Render approvals in the transcript**

Change the `Transcript` signature and add the two blocks after the message list, before the busy indicator:

```tsx
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
  onResolve: (item: PendingItem, decision: "approve" | "deny", trust: boolean) => void;
}) {
```

```tsx
        {resolved.map((r) => (
          <div key={r.pendingId} data-kind="resolved" className="flex max-w-[60ch] flex-col gap-1.5 border-l border-line pl-3.5">
            <span className="text-[14.5px] leading-[1.75] text-ink-soft">{r.summary}</span>
            <span className="text-[12.5px] leading-relaxed text-faint">{r.outcome}</span>
          </div>
        ))}
        {pending.map((p) => (
          <ApprovalCard key={p.pendingId} item={p} onResolve={(d, t) => onResolve(p, d, t)} />
        ))}
```

Add `pending.length` and `resolved.length` to the scroll effect's dependency array so a new approval scrolls into view:

```tsx
  }, [messages, busy, pending.length, resolved.length]);
```

- [ ] **Step 11: Thread the props through `AgentPanel`**

Add the same three props to `AgentPanel`'s signature and pass them straight to `Transcript`. No logic.

- [ ] **Step 12: Move the streams into `Workspace` and delete the dialog**

In `Workspace.tsx`:

```tsx
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [resolved, setResolved] = useState<ResolvedItem[]>([]);

  useEffect(() => {
    const stopData = openPendingStream(dashboardBase, (e) => setPending((p) => reducePending(p, e, "data")));
    const stopInfra = openInfraPendingStream(agentBase, (e) => setPending((p) => reducePending(p, e, "infra")));
    return () => { stopData(); stopInfra(); };
  }, [agentBase, dashboardBase]);

  async function resolve(item: PendingItem, decision: "approve" | "deny", trust: boolean) {
    const summary = summarizeOp(item);
    try {
      if (item.origin === "data") {
        await resolvePending(dashboardBase, item.pendingId, decision, decision === "approve" && trust);
      } else {
        await resolveInfraPending(agentBase, item.pendingId, decision);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setResolved((r) => [...r, { pendingId: item.pendingId, summary, outcome: `Could not resolve — ${detail}` }]);
      return;
    }
    const outcome =
      decision === "approve"
        ? trust && item.origin === "data"
          ? "Approved, and this surface is now trusted for adds and edits."
          : "Approved — the host executed it."
        : "Denied — nothing was written.";
    setResolved((r) => [...r, { pendingId: item.pendingId, summary, outcome }]);
    setPending((p) => p.filter((x) => x.pendingId !== item.pendingId));
  }
```

On a failed resolve the item stays in `pending` so it can be retried, and the failure is recorded alongside it — do not drop it.

Pass `pending`, `resolved`, and `onResolve={resolve}` to `AgentPanel`.

In `App.tsx`, remove the `ConfirmationDialog` import and its element, leaving `<Workspace ... />` alone in the fragment (the fragment can collapse to a bare return). Delete `client/src/components/ConfirmationDialog.tsx` and `client/test/ConfirmationDialog.test.tsx`.

- [ ] **Step 13: Add a Workspace-level integration test**

```tsx
// append to client/test/Workspace.test.tsx
  it("renders a pending write in the transcript and resolves it in place", async () => {
    let emit: ((e: unknown) => void) | null = null;
    vi.mocked(openPendingStream).mockImplementation((_b, cb) => { emit = cb; return () => {}; });
    setup();
    act(() => {
      emit?.({
        type: "added",
        write: { pendingId: "p1", source: "printers", op: { kind: "update", table: "jobs" }, surfaceId: "farm" },
      });
    });
    expect(await screen.findByText("Update rows in printers.jobs")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByText(/Approved/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
```

Add `openPendingStream`, `openInfraPendingStream`, `resolvePending`, and `resolveInfraPending` to the file's `vi.mock` of `../src/lib/tauri`, and import `waitFor`.

- [ ] **Step 14: Run the suite and typecheck**

Run: `cd client && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 15: Commit**

```bash
git add -A client/src client/test
git commit -m "feat(client): move approvals from a modal into the transcript

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Composer restyle

**Files:**
- Modify: `client/src/components/Composer.tsx:95-170`
- Test: modify `client/test/Composer.test.tsx`

**Interfaces:**
- Consumes: nothing new
- Produces: unchanged props; adds optional `contextLabel?: string` rendered when the draft is empty

- [ ] **Step 1: Write the failing test**

```tsx
// append to client/test/Composer.test.tsx
  it("shows the hint row when the draft is empty and the send affordance once it is not", async () => {
    render(<Composer slashCommands={[]} onSend={vi.fn().mockResolvedValue(true)} />);
    expect(screen.getByText("/ for commands")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Send/ })).toBeNull();
    await userEvent.type(screen.getByRole("textbox"), "hi");
    expect(screen.getByRole("button", { name: /Send/ })).toBeTruthy();
  });

  it("shows a context label when one is given and the draft is empty", () => {
    render(<Composer slashCommands={[]} onSend={vi.fn()} contextLabel="18.4k of 200k context" />);
    expect(screen.getByText("18.4k of 200k context")).toBeTruthy();
  });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && npx vitest run test/Composer.test.tsx`
Expected: FAIL — hint text absent, Send always rendered

- [ ] **Step 3: Restyle the composer**

Add `contextLabel` to the props, then replace the returned JSX's outer container, textarea, and button row (keep `stage`, `submit`, `pick`, `onKeyDown`, the slash popup, the error line, and the staged-file chips as they are — only their classNames change):

```tsx
    <div
      className="relative flex flex-none flex-col gap-3 border-t border-line px-6 pb-4 pt-4.5"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length > 0) void stage(e.dataTransfer.files);
      }}
    >
```

```tsx
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
```

The mock's `18.4k of 200k context` is computed from a hardcoded formula; the client has no token accounting, so `contextLabel` stays optional and `Workspace` does not pass it. It exists so the slot is real when a token count becomes available.

Restyle the slash popup list to `border border-line bg-panel` with `hover:bg-raised` on its options.

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd client && npx vitest run test/Composer.test.tsx`
Expected: PASS. Existing tests that click a `Send` button after typing still pass; one that asserts `Send` is disabled on an empty draft must change to asserting it is absent.

- [ ] **Step 5: Run the suite and typecheck**

Run: `cd client && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add client/src/components/Composer.tsx client/test/Composer.test.tsx
git commit -m "feat(client): restyle the composer to the 5a design

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Chat tabs restyle

Kept per the decision to preserve multi-session work. The mock has no tab strip, so this is a design gap filled in its language: a thin mono strip above the transcript.

**Files:**
- Modify: `client/src/components/ChatTabs.tsx`
- Test: modify `client/test/ChatTabs.test.tsx`

**Interfaces:**
- Consumes: `TabState`
- Produces: unchanged props

- [ ] **Step 1: Restyle**

Replace the classNames in `client/src/components/ChatTabs.tsx`:

```tsx
    <div role="tablist" aria-label="Open sessions" className="flex flex-none items-center gap-2 overflow-x-auto border-b border-line px-4 py-2">
      {tabs.map((t) => (
        <span
          key={t.key}
          className={
            t.key === activeKey
              ? "mn flex shrink-0 items-center gap-1.5 border-b border-accent pb-1 text-ink"
              : "mn flex shrink-0 items-center gap-1.5 border-b border-transparent pb-1 text-faint hover:text-muted"
          }
        >
          <button role="tab" aria-selected={t.key === activeKey} onClick={() => onFocus(t.key)} className="flex items-center gap-1.5">
            <span className="max-w-40 truncate">{t.title}</span>
            {t.openTurns > 0 && (
              <span aria-label={`${t.title} running`} className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            )}
            {t.unread && (
              <span aria-label={`${t.title} unread`} className="h-1.5 w-1.5 rounded-full border border-accent" />
            )}
          </button>
          <button aria-label={`Close ${t.title}`} onClick={() => onClose(t.key)} className="text-faint hover:text-danger">
            ×
          </button>
        </span>
      ))}
    </div>
```

- [ ] **Step 2: Run the tests**

Run: `cd client && npx vitest run test/ChatTabs.test.tsx`
Expected: PASS unchanged — every assertion is on roles, labels, and text.

- [ ] **Step 3: Run the suite and typecheck**

Run: `cd client && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add client/src/components/ChatTabs.tsx
git commit -m "style(client): restyle chat tabs to the 5a design

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Telemetry bar

**Files:**
- Create: `client/src/components/TelemetryBar.tsx`
- Test: `client/test/TelemetryBar.test.tsx`

**Interfaces:**
- Consumes: `OntologyNode`, `Tab`
- Produces: `<TelemetryBar surfaces={number} nodes={OntologyNode[]} queued={number} syncedAt={string | null} />`

- [ ] **Step 1: Write the failing test**

```tsx
// client/test/TelemetryBar.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TelemetryBar } from "../src/components/TelemetryBar";
import type { OntologyNode } from "../src/lib/types";

const n = (id: string, rels: number): OntologyNode => ({
  type: "service", id, title: id, managed: "system", props: {},
  relationships: Array.from({ length: rels }, (_, i) => ({ edge: "uses", target: `t${i}` })),
});

describe("TelemetryBar", () => {
  it("counts surfaces, nodes, and summed edges", () => {
    render(<TelemetryBar surfaces={6} nodes={[n("a", 2), n("b", 3)]} queued={0} syncedAt={null} />);
    expect(screen.getByText("6")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
  });

  it("reports a clear queue", () => {
    render(<TelemetryBar surfaces={0} nodes={[]} queued={0} syncedAt={null} />);
    expect(screen.getByText("QUEUE clear")).toBeTruthy();
  });

  it("reports held items with correct pluralization", () => {
    const { rerender } = render(<TelemetryBar surfaces={0} nodes={[]} queued={1} syncedAt={null} />);
    expect(screen.getByText("QUEUE 1 held")).toBeTruthy();
    rerender(<TelemetryBar surfaces={0} nodes={[]} queued={3} syncedAt={null} />);
    expect(screen.getByText("QUEUE 3 held")).toBeTruthy();
  });

  it("omits the sync stamp when the ontology has never synced", () => {
    render(<TelemetryBar surfaces={0} nodes={[]} queued={0} syncedAt={null} />);
    expect(screen.queryByText(/synced/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && npx vitest run test/TelemetryBar.test.tsx`
Expected: FAIL — cannot resolve `../src/components/TelemetryBar`

- [ ] **Step 3: Implement `TelemetryBar`**

```tsx
// client/src/components/TelemetryBar.tsx
import type { OntologyNode } from "../lib/types";

export function TelemetryBar({
  surfaces,
  nodes,
  queued,
  syncedAt,
}: {
  surfaces: number;
  nodes: OntologyNode[];
  queued: number;
  syncedAt: string | null;
}) {
  const edges = nodes.reduce((sum, n) => sum + n.relationships.length, 0);
  return (
    <div className="flex h-[30px] flex-none items-center gap-6 border-t border-line px-5">
      <span className="mn text-faint">SURFACES <span className="text-muted">{surfaces}</span></span>
      <span className="mn text-faint">NODES <span className="text-muted">{nodes.length}</span></span>
      <span className="mn text-faint">EDGES <span className="text-muted">{edges}</span></span>
      <span className="flex-1" />
      <span className={queued > 0 ? "mn text-warn" : "mn text-faint"}>
        {queued > 0 ? `QUEUE ${queued} held` : "QUEUE clear"}
      </span>
      {syncedAt && (
        <span className="mn text-faint">synced {new Date(syncedAt).toLocaleTimeString()}</span>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd client && npx vitest run test/TelemetryBar.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/components/TelemetryBar.tsx client/test/TelemetryBar.test.tsx
git commit -m "feat(client): add the telemetry bar

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: Assemble the three-column grid

Final layout pass: `TopBar` on top, three columns, `TelemetryBar` at the bottom. Lifts the duplicated `getOntology` fetch from Task 6 into `Workspace` and passes the snapshot down to `OntologyPanel`.

**Files:**
- Modify: `client/src/components/Workspace.tsx` (full rewrite), `client/src/components/OntologyPanel.tsx` (accept a snapshot prop instead of fetching), `client/src/components/SessionsPanel.tsx` (accept `activeKey`)
- Test: modify `client/test/Workspace.test.tsx`, `client/test/OntologyPanel.test.tsx`, `client/test/SessionsPanel.test.tsx`

**Interfaces:**
- Consumes: `TopBar` (T1), `Sidebar`/`HostPanel` (T2), `flattenNodes` (T4), `buildLineage` (T5), `SurfaceFrame` (T6), `NodeDetail` (T7), `ApprovalCard` wiring (T9), `TelemetryBar` (T12)
- Produces: `OntologyPanel` props become `{ snapshot: OntologySnapshot | null; error: string | null; onRefresh: () => void; surfaceTabs; activeSurfaceId; selectedNodeId; onSelectSurface; onSelectNode }` — it no longer calls `getOntology`. `SessionsPanel` gains `activeKey: string | null`.

- [ ] **Step 1: Lift the ontology fetch**

In `OntologyPanel.tsx`, delete the `snap`/`fetchError`/`load`/`useEffect` block and take `snapshot`, `error`, and `onRefresh` as props. Keep the local `query` state. Replace every `snap` reference with `snapshot`. Add a refresh control next to the filter input calling `onRefresh`.

In `Workspace.tsx`, own it:

```tsx
  const [ontology, setOntology] = useState<OntologySnapshot | null>(null);
  const [ontologyError, setOntologyError] = useState<string | null>(null);

  const loadOntology = useCallback(async () => {
    try {
      setOntology(await getOntology(agentBase));
      setOntologyError(null);
    } catch (e) {
      setOntologyError(e instanceof Error ? e.message : String(e));
    }
  }, [agentBase]);

  useEffect(() => { void loadOntology(); }, [loadOntology]);

  const ontologyNodes = ontology?.nodes ?? [];
```

- [ ] **Step 2: Mark the active session in the sidebar**

Add `activeKey: string | null` to `SessionsPanel`'s props and apply it in the row button: when `s.id === activeKey`, use `border-l-2 border-accent bg-raised`, title color `text-ink`, and render `open` in accent in place of `relTime(...)`. Pass `activeKey={chat.store.activeKey}` from `Workspace`.

- [ ] **Step 3: Write the failing layout test**

```tsx
// append to client/test/Workspace.test.tsx
  it("lays out the top bar, three columns, and the telemetry bar", async () => {
    setup();
    expect(screen.getByText("RHUMB")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "SESSIONS" })).toBeTruthy();
    expect(await screen.findByText("QUEUE clear")).toBeTruthy();
  });

  it("counts registered surfaces and ontology nodes in the telemetry bar", async () => {
    let emit: ((s: unknown) => void) | null = null;
    vi.mocked(openRegistryStream).mockImplementation((_b, cb) => { emit = cb; return () => {}; });
    setup();
    act(() => {
      emit?.({ surfaces: [{ id: "x1", title: "Sales", url: "/s/x1", kind: "table", created: "", updated: "" }] });
    });
    // The label and its count live in one element ("SURFACES 1"), so match the
    // whole string rather than the bare label.
    await waitFor(() => expect(screen.getByText(/SURFACES\s*1/)).toBeTruthy());
  });
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `cd client && npx vitest run test/Workspace.test.tsx`
Expected: FAIL — `RHUMB` and `QUEUE clear` are not rendered

- [ ] **Step 5: Rewrite the `Workspace` render**

```tsx
  return (
    <div className="flex h-screen flex-col bg-bg">
      <TopBar title={active?.title ?? "Rhumb"} turns={userTurns} baseUrl={agentBase} />
      <div className="grid min-h-0 flex-1 gap-px overflow-x-auto bg-line [grid-template-columns:272px_minmax(320px,0.9fr)_minmax(560px,1.3fr)]">
        <Sidebar active={tab} onSelect={setTab}>
          {tab === "sessions" && (
            <SessionsPanel
              agentBase={agentBase}
              tabs={chat.store.tabs}
              activeKey={chat.store.activeKey}
              onOpen={(m) => void chat.openSession({ id: m.id, title: m.title })}
              onNew={() => chat.newDraft()}
            />
          )}
          {tab === "map" && (
            <OntologyPanel
              snapshot={ontology}
              error={ontologyError}
              onRefresh={() => void loadOntology()}
              surfaceTabs={surfTabs}
              activeSurfaceId={activeSurf}
              selectedNodeId={selectedNode}
              onSelectSurface={(id) => { setActiveSurf(id); setSelectedNode(null); }}
              onSelectNode={setSelectedNode}
            />
          )}
          {tab === "host" && (
            <HostPanel agentBase={agentBase} dashboardBase={dashboardBase} onDisconnect={onDisconnect} />
          )}
        </Sidebar>

        <div className="flex min-h-0 min-w-0 flex-col bg-bg">
          <ChatTabs tabs={chat.store.tabs} activeKey={chat.store.activeKey} onFocus={chat.focus} onClose={chat.close} />
          {active ? (
            <AgentPanel
              tab={active}
              slashCommands={active.agent.slashCommands}
              onSend={(text, files) => chat.send(active.key, text, files)}
              pending={pending}
              resolved={resolved}
              onResolve={resolve}
            />
          ) : (
            <p className="m-auto text-[13px] text-faint">Open a session or start a new one.</p>
          )}
        </div>

        <div className="flex min-h-0 min-w-0 flex-col bg-bg">
          <SurfaceFrame
            lineage={lineageId ? buildLineage(ontologyNodes, lineageId) : []}
            onDetach={selected ? undefined : detach}
            detachError={detachError}
          >
            {selected ? (
              <NodeDetail node={selected} />
            ) : (
              <Canvas dashboardBase={dashboardBase} active={activeSurface} />
            )}
          </SurfaceFrame>
        </div>
      </div>
      <TelemetryBar
        surfaces={surfTabs.length}
        nodes={ontologyNodes}
        queued={pending.length}
        syncedAt={ontology?.syncedAt ?? null}
      />
    </div>
  );
```

With `userTurns` derived above:

```tsx
  const userTurns = active ? active.agent.messages.filter((m) => m.kind === "user").length : 0;
```

The mock's fixed `.9fr / 1.3fr` split replaces the old `resize-x` chat column. That is a deliberate loss of the drag handle; if it proves annoying in dogfooding, reintroduce it by making the middle column `resize-x` with `min-w-[320px]`.

- [ ] **Step 6: Update the panel tests for the new props**

`OntologyPanel.test.tsx` no longer mocks `getOntology` — pass a `snapshot` object directly and drop the `vi.mock` if nothing else in the file needs it. `SessionsPanel.test.tsx` gains `activeKey={null}` on every render.

- [ ] **Step 7: Run the suite and typecheck**

Run: `cd client && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 8: Verify the real app renders**

Run: `cd client && npm run build`
Expected: clean build. Then `npm run tauri:dev` and confirm by eye: three columns with 1px rules, orange accent, no white except inside the surface iframe, telemetry bar populated. Resize the window below 1152px and confirm the grid scrolls horizontally rather than collapsing.

- [ ] **Step 9: Commit**

```bash
git add client/src/components client/test
git commit -m "feat(client): assemble the 5a three-column workspace

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 14: Connection screen restyle

Not in the design, but it is the first screen an operator sees and would otherwise still be blue-on-slate.

**Files:**
- Modify: `client/src/components/ConnectionScreen.tsx`
- Test: `client/test/ConnectionScreen.test.tsx` (assertions should survive; update only what breaks)

**Interfaces:**
- Consumes: theme tokens from Task 1
- Produces: no API change

- [ ] **Step 1: Restyle**

Read `client/src/components/ConnectionScreen.tsx` in full, then apply the design's idiom without changing any logic, handler, or conditional:
- Page: `bg-bg`, centered column, `max-w-[420px]`.
- Heading: `RHUMB` in `font-mono text-[13px] tracking-[0.22em] text-ink`, with the step description below in `text-[13px] text-muted`.
- Section labels: `.ey`.
- Inputs: `border border-line-strong bg-bg px-2.5 py-2 text-[12.5px]`, `outline-none`, `placeholder:text-faint`, `focus:border-accent`.
- Primary button: `bg-accent text-bg px-4 py-2.5 text-[13px] rounded-sm`.
- Secondary button: `border border-line-strong text-muted px-4 py-2.5 text-[13px] rounded-sm`.
- Discovered-host rows: `.mn`, hover `bg-raised`, accent left rule when selected.
- Errors: `text-danger text-[12.5px]`.

- [ ] **Step 2: Run the tests**

Run: `cd client && npx vitest run test/ConnectionScreen.test.tsx`
Expected: PASS. If an assertion matched button text you changed, restore the exact original label — this task changes appearance only, never copy that a test names.

- [ ] **Step 3: Run the suite and typecheck**

Run: `cd client && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add client/src/components/ConnectionScreen.tsx client/test/ConnectionScreen.test.tsx
git commit -m "style(client): restyle the connection screen to the 5a palette

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 15 (optional — the only host change): permission mode and trust badge

Everything above is client-only. This task adds two read-only endpoints so the two mock chips the client cannot currently know become truthful. Skip it and the reskin is still complete; the chips simply do not render.

**Do not start this task without confirming that a host change is wanted.** It breaks the "just a new face" boundary set for Tasks 1–14.

**Files:**
- Modify: `agent-host/src/server.ts` (add `GET /status` behind the identity guard), `dashboard-host/src/data/router.ts` (add `GET /trust`)
- Modify: `client/src-tauri/src/proxy.rs`, `client/src-tauri/src/lib.rs`, `client/src/lib/tauri.ts`, `client/src/components/TopBar.tsx`, `client/src/components/SurfaceFrame.tsx`, `client/src/components/Workspace.tsx`
- Test: `agent-host/test/` and `dashboard-host/test/` per those packages' conventions; `client/test/TopBar.test.tsx`, `client/test/SurfaceFrame.test.tsx`

**Interfaces:**
- Produces:
  - `GET /status` → `{ permissionMode: string }`, mounted **after** the identity guard so it is never anonymous
  - `GET /data/trust` → `{ trusted: { source: string; surfaceId: string }[] }`
  - `getHostStatus(agentBase: string): Promise<{ permissionMode: string }>`
  - `getTrustedSurfaces(dashboardBase: string): Promise<{ source: string; surfaceId: string }[]>`
  - `TopBar` gains `permissionMode?: string`; `SurfaceFrame` gains `mode?: string`

- [ ] **Step 1: Write the failing host tests**

In `agent-host`, following that package's existing route-test style, assert that `GET /status` returns the configured `permissionMode` for an allowlisted caller and 403 for a non-allowlisted one. In `dashboard-host`, assert `GET /data/trust` returns the pairs from a seeded `data-trust.json` and an empty array when the file is absent.

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd agent-host && npm test` and `cd dashboard-host && npm test`
Expected: FAIL — 404 on both routes

- [ ] **Step 3: Add the routes**

In `agent-host/src/server.ts`, after the identity/shell guards are registered (below line 98), add:

```ts
  // Read-only: lets the client label its own permission posture. Deliberately
  // below the identity guard — /healthz is anonymous and must stay content-free.
  app.get("/status", (_req, res) => {
    res.json({ permissionMode: deps.config.permissionMode });
  });
```

In `dashboard-host/src/data/router.ts`, add:

```ts
  // Read-only view of the trust file so the shell can label a surface honestly
  // instead of guessing. Never mutates; granting trust still goes through
  // POST /pending/:id/resolve.
  router.get("/trust", (_req, res) => {
    res.json({ trusted: loadTrust(deps.trustPath) });
  });
```

- [ ] **Step 4: Run the host tests and confirm they pass**

Run: `cd agent-host && npm test` and `cd dashboard-host && npm test`
Expected: PASS

- [ ] **Step 5: Add the Tauri proxy commands**

In `client/src-tauri/src/proxy.rs`, copy the `get_ontology` shape exactly (lines 449-459) for both:

```rust
#[tauri::command]
pub async fn get_host_status(app: tauri::AppHandle, agent_base: String) -> Result<Value, String> {
    let (url, bearer) = agent_target(&app, &agent_base, "/status")?;
    let client = reqwest::Client::new();
    let req = shell_request(client.get(&url), &bearer);
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("agent host returned {}", resp.status()));
    }
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_trusted_surfaces(app: tauri::AppHandle, dashboard_base: String) -> Result<Value, String> {
    let (url, bearer) = dashboard_target(&app, &dashboard_base, "/data/trust")?;
    let client = reqwest::Client::new();
    let req = shell_request(client.get(&url), &bearer);
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("dashboard host returned {}", resp.status()));
    }
    resp.json::<Value>().await.map_err(|e| e.to_string())
}
```

Register both in the `invoke_handler` list in `client/src-tauri/src/lib.rs` (alongside `proxy::get_ontology` at line 112).

- [ ] **Step 6: Add the TypeScript wrappers**

```ts
// client/src/lib/tauri.ts
export interface HostStatus { permissionMode: string }

export function getHostStatus(agentBase: string): Promise<HostStatus> {
  return invoke<HostStatus>("get_host_status", { agentBase });
}

export interface TrustPair { source: string; surfaceId: string }

export async function getTrustedSurfaces(dashboardBase: string): Promise<TrustPair[]> {
  const r = await invoke<{ trusted: TrustPair[] }>("get_trusted_surfaces", { dashboardBase });
  return r.trusted;
}
```

- [ ] **Step 7: Write the failing client tests**

```tsx
// append to client/test/TopBar.test.tsx
  it("shows the permission mode when one is given", () => {
    render(<TopBar title="x" turns={0} baseUrl="https://b.ts.net" permissionMode="acceptEdits" />);
    expect(screen.getByText(/acceptEdits/)).toBeTruthy();
  });

  it("shows no permission mode when the host does not report one", () => {
    render(<TopBar title="x" turns={0} baseUrl="https://b.ts.net" />);
    expect(screen.queryByText(/acceptEdits/)).toBeNull();
  });
```

```tsx
// append to client/test/SurfaceFrame.test.tsx
  it("shows a capability badge when one is given", () => {
    render(<SurfaceFrame lineage={["x"]} mode="read-write" onDetach={vi.fn()} detachError={false}><p>b</p></SurfaceFrame>);
    expect(screen.getByText("read-write")).toBeTruthy();
  });

  it("shows no badge when the mode is unknown", () => {
    render(<SurfaceFrame lineage={["x"]} onDetach={vi.fn()} detachError={false}><p>b</p></SurfaceFrame>);
    expect(screen.queryByText("read-write")).toBeNull();
    expect(screen.queryByText("read-only")).toBeNull();
  });
```

- [ ] **Step 8: Run them and confirm they fail**

Run: `cd client && npx vitest run test/TopBar.test.tsx test/SurfaceFrame.test.tsx`
Expected: FAIL — neither component accepts the new prop

- [ ] **Step 9: Render the two chips**

`TopBar`: add `permissionMode?: string` and append `{permissionMode && ` · ${permissionMode}`}` inside the existing status span.

`SurfaceFrame`: add `mode?: string` and render `{mode && <span className="mn shrink-0 text-faint">{mode}</span>}` just before the detach button.

`Workspace`: fetch both on mount, tolerate failure (an older host 404s), and derive the badge:

```tsx
  const [permissionMode, setPermissionMode] = useState<string | undefined>(undefined);
  const [trusted, setTrusted] = useState<TrustPair[]>([]);

  useEffect(() => {
    getHostStatus(agentBase).then((s) => setPermissionMode(s.permissionMode)).catch(() => setPermissionMode(undefined));
  }, [agentBase]);

  useEffect(() => {
    getTrustedSurfaces(dashboardBase).then(setTrusted).catch(() => setTrusted([]));
  }, [dashboardBase]);

  // Only two states are knowable from the trust file: a surface the operator
  // has trusted for adds and edits, and one that has not been trusted. Never
  // claim "read-only" — nothing the client can read proves a surface cannot
  // write.
  const surfaceMode = activeSurf
    ? trusted.some((t) => t.surfaceId === activeSurf)
      ? "trusted · adds and edits"
      : "writes need approval"
    : undefined;
```

Refresh `trusted` after any approval that granted trust: call `void getTrustedSurfaces(dashboardBase).then(setTrusted).catch(() => {})` at the end of `resolve()` when `trust === true`.

- [ ] **Step 10: Run everything**

Run: `cd client && npm test && npm run typecheck && cd ../agent-host && npm test && cd ../dashboard-host && npm test`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add -A client agent-host dashboard-host
git commit -m "feat: report permission mode and surface trust to the shell

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification before the branch is done

- [ ] `cd client && npm test && npm run typecheck && npm run build` — all green
- [ ] `npm run tauri:dev` and walk each sidebar tab, open a session, send a turn, click a map node, detach a surface
- [ ] Stage a real write from a live surface against the box and approve it in the transcript; confirm the pending disappears, the outcome line appears, and the audit entry lands with `auth: "approval"`
- [ ] Repeat with deny; confirm the outcome line says nothing was written and no audit `executed` entry appears
- [ ] Approve with **Trust this surface** checked, then trigger an update from the same surface; confirm it executes without a card and the audit shows `auth: "trust"`
- [ ] Trigger a delete from that same trusted surface; confirm it still raises an approval card (this is the F22 guard from PR #29 — if it auto-executes, stop and investigate before merging)
- [ ] Kill the agent host mid-session; confirm the top bar shows `unreachable` and the stale-session banner still appears
