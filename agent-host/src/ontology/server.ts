import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { OntologyOps } from "./ops.js";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true as const });

export function createOntologyServer(ops: OntologyOps) {
  return createSdkMcpServer({
    name: "ontology",
    version: "1.0.0",
    tools: [
      tool("sync", "Rebuild the system-layer ontology from current infrastructure state", {}, async (_a, _extra) => {
        try { return ok(JSON.stringify(ops.sync())); } catch (e) { return fail(String(e)); }
      }),
      tool("query", "Query the ontology graph", {
        kind: z.enum(["node", "type", "neighbors"]),
        id: z.string().optional(),
        type: z.string().optional(),
        edge: z.string().optional(),
        direction: z.enum(["out", "in", "both"]).optional(),
      }, async (a, _extra) => {
        try {
          const q =
            a.kind === "node" ? { kind: "node" as const, id: a.id ?? "" } :
            a.kind === "type" ? { kind: "type" as const, type: a.type ?? "" } :
            { kind: "neighbors" as const, id: a.id ?? "", edge: a.edge, direction: a.direction };
          return ok(JSON.stringify(ops.query(q)));
        } catch (e) { return fail(String(e)); }
      }),
      tool("upsert_node", "Create or update a domain entity node", {
        id: z.string(), title: z.string(), subtype: z.string().optional(),
        props: z.record(z.string(), z.string()).optional(),
      }, async (a, _extra) => {
        try {
          return ok(JSON.stringify(ops.upsert({
            id: a.id, title: a.title, subtype: a.subtype,
            props: a.props as Record<string, string> | undefined,
          })));
        } catch (e) { return fail(String(e)); }
      }),
      tool("link", "Add a typed edge from a domain node to another node", {
        from: z.string(), edge: z.string(), to: z.string(),
      }, async (a, _extra) => {
        try { return ok(JSON.stringify(ops.link(a.from, a.edge, a.to))); } catch (e) { return fail(String(e)); }
      }),
    ],
  });
}
