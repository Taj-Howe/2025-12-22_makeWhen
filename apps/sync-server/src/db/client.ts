import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { loadConfig } from "../config.ts";

export type DbRow<TColumns extends string = string> = Record<
  TColumns,
  string | null
>;

let pool: Pool | null = null;

const getDatabaseUrl = () => {
  const config = loadConfig();
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required for database operations.");
  }
  return config.databaseUrl;
};

const getPool = () => {
  if (pool) {
    return pool;
  }
  pool = new Pool({
    connectionString: getDatabaseUrl(),
  });
  return pool;
};

export const executeSql = async (sql: string) => {
  const result = await getPool().query(sql);
  return result.rows;
};

export const querySql = async <TRow extends QueryResultRow = QueryResultRow>(
  sql: string,
  values: unknown[] = []
): Promise<QueryResult<TRow>> => {
  return getPool().query<TRow>(sql, values);
};

export const queryRows = async <TColumns extends string>(
  sql: string,
  columns: readonly TColumns[]
): Promise<Array<DbRow<TColumns>>> => {
  const result = await getPool().query(sql);
  return result.rows.map((rowValue) => {
    const row = {} as DbRow<TColumns>;
    columns.forEach((column) => {
      const value = (rowValue as Record<string, unknown>)[column];
      row[column] =
        value === null || value === undefined ? null : String(value);
    });
    return row;
  });
};

export const sqlLiteral = (value: string) => {
  return `'${value.replace(/'/g, "''")}'`;
};

export const pingDatabase = async () => {
  try {
    await getPool().query("SELECT 1;");
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export const closePool = async () => {
  if (!pool) {
    return;
  }
  await pool.end();
  pool = null;
};
