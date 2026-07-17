import postgres, { type Sql } from "postgres";

export type DbClient = {
  sql: Sql;
  close: () => Promise<void>;
};

export function createDbClient(databaseUrl: string, opts?: { max?: number }): DbClient {
  const sql = postgres(databaseUrl, {
    max: opts?.max ?? 10,
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
