import pg from "pg";
import { getDatabaseUrl, runMigrations } from "./dbMigrate.mjs";

const { Pool } = pg;

const main = async () => {
  const databaseUrl = getDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("CREATE SCHEMA public");
  } finally {
    await pool.end();
  }

  await runMigrations();
};

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
