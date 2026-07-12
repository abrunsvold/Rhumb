import pg from "pg";
import type { AdminExecutor } from "./types.js";

export function createAdminExecutor(connectionString: string): AdminExecutor {
  const pool = new pg.Pool({ connectionString });
  return {
    async exec(sql: string) {
      await pool.query(sql);
    },
    async close() {
      await pool.end();
    },
  };
}

// Row-returning admin query with a single-use connection per call. Used by the
// ddl-facts refresher, which runs on ontology reads (panel open) — not a hot
// path, so no long-lived pool to manage or leak.
export function createAdminQuery(connectionString: string): (sql: string) => Promise<Array<Record<string, unknown>>> {
  return async (sql: string) => {
    const pool = new pg.Pool({ connectionString, max: 1 });
    try {
      const r = await pool.query(sql);
      return r.rows as Array<Record<string, unknown>>;
    } finally {
      await pool.end();
    }
  };
}

// Build an admin connection string for another database on the same server by
// swapping the URL path. Used to point a superuser executor at a freshly
// provisioned DB (event triggers are per-database). dbName is IDENT-validated
// upstream in provisionDatabase.
export function connStringForDb(adminConnectionString: string, dbName: string): string {
  const u = new URL(adminConnectionString);
  u.pathname = "/" + dbName;
  return u.toString();
}
