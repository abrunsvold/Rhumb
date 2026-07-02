import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import type { TranscriptMessage } from "./types.js";

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  preview: string;
  archived: boolean;
}

export interface SessionService {
  upsertFromTurn(id: string, prompt: string): void;
  list(includeArchived?: boolean): SessionMeta[];
  rename(id: string, title: string): boolean;
  archive(id: string): boolean;
  readTranscript(id: string): TranscriptMessage[] | null;
}

const TITLE_MAX = 60;
const SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function truncateTitle(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  if (flat.length <= TITLE_MAX) return flat;
  const cut = flat.slice(0, TITLE_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace > 20 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()}…`;
}

function load(indexPath: string): SessionMeta[] {
  try {
    const raw = JSON.parse(readFileSync(indexPath, "utf8"));
    return Array.isArray(raw) ? (raw as SessionMeta[]) : [];
  } catch {
    return [];
  }
}

function save(indexPath: string, sessions: SessionMeta[]): void {
  mkdirSync(dirname(indexPath), { recursive: true });
  const tmp = `${indexPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(sessions, null, 2));
  renameSync(tmp, indexPath);
}

export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

function blockToMessages(record: Record<string, unknown>): TranscriptMessage[] {
  const type = record.type;
  if ((type !== "user" && type !== "assistant") || record.isSidechain === true) return [];
  const message = record.message as Record<string, unknown> | undefined;
  const content = message?.content;
  const out: TranscriptMessage[] = [];
  if (typeof content === "string") {
    if (type === "user" && content.length > 0) out.push({ kind: "user", text: content });
    if (type === "assistant" && content.length > 0) out.push({ kind: "text", text: content });
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
      out.push({ kind: type === "user" ? "user" : "text", text: b.text });
    } else if (type === "assistant" && b.type === "tool_use" && typeof b.name === "string") {
      out.push({ kind: "tool", text: b.name, toolName: b.name, toolInput: b.input });
    }
    // tool_result and anything else: skipped
  }
  return out;
}

function firstUserText(file: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const user = blockToMessages(JSON.parse(line)).find((m) => m.kind === "user");
      if (user) return user.text;
    } catch {
      // corrupt line: keep scanning
    }
  }
  return null;
}

export function createSessionService(deps: {
  indexPath: string;
  projectsDir: string;
  workspace: string;
  now: () => string;
}): SessionService {
  let sessions = load(deps.indexPath);

  const persist = () => save(deps.indexPath, sessions);

  // Adopt transcripts that predate the index (or were created by other
  // clients) so the panel lists them. Best-effort: any disk problem leaves
  // the index as loaded.
  function backfillFromDisk(): void {
    const dir = join(deps.projectsDir, encodeProjectDir(resolve(deps.workspace)));
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    let added = false;
    for (const name of names) {
      if (!name.endsWith(".jsonl") || name.startsWith("agent-")) continue;
      const id = name.slice(0, -".jsonl".length);
      if (!SESSION_ID_RE.test(id)) continue;
      if (sessions.some((s) => s.id === id)) continue;
      const file = join(dir, name);
      const text = firstUserText(file);
      if (text === null || text.length === 0) continue;
      let stamp = deps.now();
      try {
        stamp = statSync(file).mtime.toISOString();
      } catch {
        // keep now()
      }
      const title = truncateTitle(text);
      sessions.push({ id, title, createdAt: stamp, lastActiveAt: stamp, preview: title, archived: false });
      added = true;
    }
    if (added) persist();
  }
  backfillFromDisk();

  return {
    upsertFromTurn(id, prompt) {
      const existing = sessions.find((s) => s.id === id);
      if (existing) {
        existing.lastActiveAt = deps.now();
      } else {
        const title = truncateTitle(prompt);
        sessions.push({
          id,
          title,
          createdAt: deps.now(),
          lastActiveAt: deps.now(),
          preview: title,
          archived: false,
        });
      }
      persist();
    },
    list(includeArchived = false) {
      return sessions
        .filter((s) => includeArchived || !s.archived)
        .slice()
        .sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : -1));
    },
    rename(id, title) {
      const s = sessions.find((x) => x.id === id);
      if (!s) return false;
      s.title = title;
      persist();
      return true;
    },
    archive(id) {
      const s = sessions.find((x) => x.id === id);
      if (!s) return false;
      s.archived = true;
      persist();
      return true;
    },
    readTranscript(id) {
      const file = join(
        deps.projectsDir,
        encodeProjectDir(resolve(deps.workspace)),
        `${id}.jsonl`,
      );
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        return null;
      }
      const messages: TranscriptMessage[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          messages.push(...blockToMessages(JSON.parse(line)));
        } catch {
          // corrupt line: skip
        }
      }
      return messages;
    },
  };
}
