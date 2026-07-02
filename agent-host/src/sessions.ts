import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
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

export function createSessionService(deps: {
  indexPath: string;
  projectsDir: string;
  workspace: string;
  now: () => string;
}): SessionService {
  let sessions = load(deps.indexPath);

  const persist = () => save(deps.indexPath, sessions);

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
    readTranscript() {
      return null; // implemented in the transcript task
    },
  };
}
