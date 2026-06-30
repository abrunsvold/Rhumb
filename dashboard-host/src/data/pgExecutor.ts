import pg from "pg";
import type { DataSource, QueryExecutor } from "./types.js";

// One executor bound to a single source's pool. The router holds one executor
// per source id (constructed by the caller); see index.ts wiring.
export function createPgExecutor(source: DataSource): QueryExecutor {
  const pool = new pg.Pool({ connectionString: source.connectionString });
  return {
    async run(sql) {
      const result = await pool.query(sql.text, sql.params as unknown[]);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
    },
  };
}
