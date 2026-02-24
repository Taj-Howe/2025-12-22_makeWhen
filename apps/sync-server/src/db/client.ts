import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../config.ts";

const execFileAsync = promisify(execFile);

export type DbRow<TColumns extends string = string> = Record<
  TColumns,
  string | null
>;

const getDatabaseUrl = () => {
  const config = loadConfig();
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required for database operations.");
  }
  return config.databaseUrl;
};

export const executeSql = async (sql: string) => {
  const databaseUrl = getDatabaseUrl();
  const result = await execFileAsync("psql", [
    databaseUrl,
    "-X",
    "-q",
    "-v",
    "ON_ERROR_STOP=1",
    "-t",
    "-A",
    "-F",
    "\t",
    "-c",
    sql,
  ]);
  return result.stdout.trim();
};

export const queryRows = async <TColumns extends string>(
  sql: string,
  columns: readonly TColumns[]
): Promise<Array<DbRow<TColumns>>> => {
  const stdout = await executeSql(sql);
  if (!stdout) {
    return [];
  }
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const values = line.split("\t");
      const row = {} as DbRow<TColumns>;
      columns.forEach((column, index) => {
        row[column] = values[index] ?? null;
      });
      return row;
    });
};

export const sqlLiteral = (value: string) => {
  return `'${value.replace(/'/g, "''")}'`;
};

export const pingDatabase = async () => {
  try {
    await executeSql("SELECT 1;");
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export const ensurePsqlAvailable = async () => {
  try {
    await execFileAsync("psql", ["--version"]);
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
