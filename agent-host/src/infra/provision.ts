import { readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync } from "../fsAtomic.js";
import type { AdminExecutor, DataSourceEntry } from "./types.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function appendDataSource(path: string, entry: DataSourceEntry): DataSourceEntry[] {
  let current: DataSourceEntry[] = [];
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(raw)) current = raw;
    } catch {
      current = [];
    }
  }
  if (current.some((s) => s.id === entry.id)) return current;
  const next = [...current, entry];
  atomicWriteFileSync(path, JSON.stringify(next, null, 2));
  return next;
}

export async function provisionDatabase(
  deps: { admin: AdminExecutor; dataSourcesPath: string; password: () => string; adminConnectionString?: string },
  name: string,
): Promise<DataSourceEntry> {
  if (!IDENT.test(name)) throw new Error(`invalid identifier: ${name}`);
  const pw = deps.password();
  // Parameterizing identifiers isn't supported by Postgres DDL; the IDENT guard
  // above is the safety boundary, and the password is single-quoted (no quotes allowed).
  if (pw.includes("'")) throw new Error("invalid password");
  await deps.admin.exec(`CREATE ROLE "${name}" LOGIN PASSWORD '${pw}'`);
  await deps.admin.exec(`CREATE DATABASE "${name}" OWNER "${name}"`);
  await deps.admin.exec(`GRANT ALL PRIVILEGES ON DATABASE "${name}" TO "${name}"`);

  // Build the new connection string from the admin host/port (default localhost:5432).
  let host = "localhost", port = "5432";
  if (deps.adminConnectionString) {
    try {
      const u = new URL(deps.adminConnectionString);
      host = u.hostname || host;
      port = u.port || port;
    } catch {
      /* keep defaults */
    }
  }
  const entry: DataSourceEntry = {
    id: name,
    type: "postgres",
    mode: "read-write",
    connectionString: `postgres://${name}:${pw}@${host}:${port}/${name}`,
  };
  appendDataSource(deps.dataSourcesPath, entry);
  return entry;
}
