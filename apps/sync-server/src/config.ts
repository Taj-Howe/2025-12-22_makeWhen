import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type AuthMode = "local" | "clerk";

export type SyncServerConfig = {
  port: number;
  databaseUrl: string | null;
  authMode: AuthMode;
  corsOrigin: string;
  clerkSecretKey: string;
  clerkJwtIssuer: string;
  authDefaultTeamRole: "owner" | "editor" | "viewer";
  authDefaultTeamName: string;
};

const parseEnvFile = (cwd: string) => {
  const envPath = path.join(cwd, ".env");
  if (!existsSync(envPath)) {
    return;
  }
  const source = readFileSync(envPath, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const rawValue = trimmed.slice(eq + 1).trim();
    const value = rawValue.replace(/^['\"]|['\"]$/g, "");
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
};

const parsePort = (value: string | undefined) => {
  const parsed = Number(value ?? "8787");
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return 8787;
  }
  return parsed;
};

const parseAuthMode = (value: string | undefined): AuthMode => {
  return value?.trim().toLowerCase() === "clerk" ? "clerk" : "local";
};

const parseRole = (
  value: string | undefined
): "owner" | "editor" | "viewer" => {
  const normalized = (value ?? "editor").trim().toLowerCase();
  if (normalized === "owner" || normalized === "editor" || normalized === "viewer") {
    return normalized;
  }
  return "editor";
};

export const loadConfig = (): SyncServerConfig => {
  parseEnvFile(process.cwd());
  const databaseUrlRaw = process.env.DATABASE_URL?.trim() ?? "";
  return {
    port: parsePort(process.env.PORT),
    databaseUrl: databaseUrlRaw.length > 0 ? databaseUrlRaw : null,
    authMode: parseAuthMode(process.env.AUTH_MODE),
    corsOrigin: process.env.CORS_ORIGIN?.trim() || "*",
    clerkSecretKey: process.env.CLERK_SECRET_KEY?.trim() || "",
    clerkJwtIssuer: process.env.CLERK_JWT_ISSUER?.trim() || "",
    authDefaultTeamRole: parseRole(process.env.AUTH_DEFAULT_TEAM_ROLE),
    authDefaultTeamName: process.env.AUTH_DEFAULT_TEAM_NAME?.trim() || "Default Team",
  };
};
