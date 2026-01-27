import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const loadEnvFile = (filename) => {
  const filePath = path.join(repoRoot, filename);
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
};

const loadEnv = () => {
  loadEnvFile("env.local");
  loadEnvFile(".env");
  loadEnvFile("env.txt");
};

export const getDatabaseUrl = () => {
  loadEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  return databaseUrl;
};

export const runMigrations = async () => {
  const databaseUrl = getDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const applied = await pool.query(
      "SELECT id FROM schema_migrations ORDER BY id"
    );
    const appliedIds = new Set(applied.rows.map((row) => row.id));

    const migrationsDir = path.join(repoRoot, "migrations");
    const files = fs
      .readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (appliedIds.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      await pool.query("BEGIN");
      try {
        await pool.query(sql);
        await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [
          file,
        ]);
        await pool.query("COMMIT");
        // eslint-disable-next-line no-console
        console.log(`Applied migration: ${file}`);
      } catch (error) {
        await pool.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await pool.end();
  }
};

if (process.argv[1] === __filename) {
  runMigrations().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
