import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeSql, queryRows } from "./client.ts";

const thisFile = fileURLToPath(import.meta.url);
const thisDir = path.dirname(thisFile);
const migrationsDir = path.resolve(thisDir, "../../migrations");

const listMigrations = async () => {
  const files = await fs.readdir(migrationsDir);
  return files
    .filter((file) => /^\d+_.+\.sql$/i.test(file))
    .sort((a, b) => a.localeCompare(b));
};

const escapeLiteral = (value: string) => value.replace(/'/g, "''");

export const runMigrations = async () => {
  await executeSql(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const appliedRows = await queryRows("SELECT version FROM schema_migrations;", [
    "version",
  ] as const);
  const applied = new Set(
    appliedRows
      .map((row) => row.version)
      .filter((value): value is string => typeof value === "string")
  );

  const migrations = await listMigrations();

  for (const migration of migrations) {
    if (applied.has(migration)) {
      continue;
    }

    const fullPath = path.join(migrationsDir, migration);
    const sql = await fs.readFile(fullPath, "utf8");
    const migrationLiteral = escapeLiteral(migration);
    await executeSql(`
      BEGIN;
      ${sql}
      INSERT INTO schema_migrations (version)
      VALUES ('${migrationLiteral}');
      COMMIT;
    `);
    console.log(`Applied migration: ${migration}`);
  }

  return {
    migrations,
    appliedCount: migrations.length,
  };
};

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === thisFile
  : false;

if (isMain) {
  runMigrations()
    .then((result) => {
      console.log(`Migration check complete. Files discovered: ${result.migrations.length}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
