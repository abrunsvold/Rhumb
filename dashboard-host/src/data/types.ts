export interface DataSource {
  id: string;
  type: "postgres";
  mode: "read" | "read-write";
  connectionString: string;
}

export type DataOp =
  | { kind: "select"; table: string; where?: Record<string, unknown>; limit?: number }
  | { kind: "insert"; table: string; values: Record<string, unknown> }
  | { kind: "update"; table: string; where: Record<string, unknown>; values: Record<string, unknown> }
  | { kind: "delete"; table: string; where: Record<string, unknown> };

export interface QueryExecutor {
  run(sql: { text: string; params: unknown[] }): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
}

export interface PendingWrite {
  pendingId: string;
  source: string;
  op: DataOp;
  surfaceId: string | null;
  createdAt: string;
}

export interface AuditEntry {
  ts: string;
  source: string;
  surfaceId: string | null;
  op: DataOp;
  decision: "executed" | "denied" | "error";
  rowCount?: number;
  error?: string;
}
