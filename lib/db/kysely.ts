import pg from "pg";
import { Kysely, PostgresDialect } from "kysely";
import type { Database } from "./schema";

const { Pool } = pg;

const createDb = () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: databaseUrl }),
    }),
  });
};

declare global {
  // eslint-disable-next-line no-var
  var __makewhenDb: Kysely<Database> | undefined;
}

export const db = globalThis.__makewhenDb ?? createDb();

if (process.env.NODE_ENV !== "production") {
  globalThis.__makewhenDb = db;
}
