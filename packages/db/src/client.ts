import postgres, { type Sql } from "postgres";

export type DbClient = {
  sql: Sql;
  close: () => Promise<void>;
};

export function createDbClient(
  databaseUrl: string,
  opts?: { max?: number; prepare?: boolean },
): DbClient {
  // A transaction-mode connection pooler (e.g. Supabase Supavisor on :6543,
  // used from serverless) does not support prepared statements. Auto-disable
  // prepares for such URLs unless the caller overrides.
  const isTransactionPooler = /pooler\.supabase\.com:6543/.test(databaseUrl);
  const sql = postgres(databaseUrl, {
    max: opts?.max ?? 10,
    prepare: opts?.prepare ?? !isTransactionPooler,
    // Fail fast instead of hanging when the database is unreachable.
    connect_timeout: 10,
    // snake_case end to end — no transform.
    onnotice: () => {},
  });
  return {
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
