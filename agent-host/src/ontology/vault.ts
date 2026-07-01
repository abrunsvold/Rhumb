import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { OntologyNode, Relationship } from "./types.js";

const KNOWN = new Set(["type", "id", "title", "managed", "created", "updated"]);

export function serializeNode(node: OntologyNode): string {
  const fm: string[] = [
    `type: ${node.type}`,
    `id: ${node.id}`,
    `title: ${node.title}`,
    `managed: ${node.managed}`,
  ];
  if (node.created) fm.push(`created: ${node.created}`);
  if (node.updated) fm.push(`updated: ${node.updated}`);
  for (const [k, v] of Object.entries(node.props)) fm.push(`${k}: ${v}`);
  const rels = node.relationships.map((r) => `- ${r.edge} [[${r.target}]]`);
  return `---\n${fm.join("\n")}\n---\n\n## Relationships\n${rels.join("\n")}\n`;
}

export function parseNode(text: string): OntologyNode | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  if (!fm.id || !fm.type) return null;
  const relationships: Relationship[] = [];
  const relRe = /^-\s+(\S+)\s+\[\[(.+?)\]\]\s*$/gm;
  let r: RegExpExecArray | null;
  while ((r = relRe.exec(text)) !== null) relationships.push({ edge: r[1], target: r[2] });
  const props: Record<string, string> = {};
  for (const [k, v] of Object.entries(fm)) if (!KNOWN.has(k)) props[k] = v;
  return {
    type: fm.type, id: fm.id, title: fm.title ?? fm.id,
    managed: fm.managed === "domain" ? "domain" : "system",
    created: fm.created, updated: fm.updated, props, relationships,
  };
}

export function readNode(path: string): OntologyNode | null {
  try { return parseNode(readFileSync(path, "utf8")); } catch { return null; }
}

export function writeNode(dir: string, node: OntologyNode): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${node.id}.md`), serializeNode(node));
}

export function listNodes(dir: string): OntologyNode[] {
  if (!existsSync(dir)) return [];
  const out: OntologyNode[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const n = readNode(join(dir, f));
    if (n) out.push(n);
  }
  return out;
}
