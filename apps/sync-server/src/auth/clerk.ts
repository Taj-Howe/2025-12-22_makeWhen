import { createClerkClient, verifyToken } from "@clerk/backend";
import type { IncomingMessage } from "node:http";
import { ApiError } from "./errors.ts";
import { loadConfig } from "../config.ts";

export type ClerkIdentity = {
  user_id: string;
  display_name: string;
  email: string | null;
};

const parseCsv = (value: string | undefined) => {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const getClerkSecretKey = () => {
  const key = loadConfig().clerkSecretKey;
  if (!key) {
    throw new ApiError(500, "BAD_REQUEST", "CLERK_SECRET_KEY is required for AUTH_MODE=clerk.");
  }
  return key;
};

export const extractBearerToken = (request: IncomingMessage): string | null => {
  const raw = request.headers.authorization;
  if (typeof raw !== "string") {
    return null;
  }
  const match = raw.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) {
    return null;
  }
  const token = match[1].trim();
  return token.length > 0 ? token : null;
};

const readPrimaryEmail = (user: Record<string, unknown>): string | null => {
  const primaryId =
    typeof user.primaryEmailAddressId === "string"
      ? user.primaryEmailAddressId
      : null;
  const emails = Array.isArray(user.emailAddresses)
    ? (user.emailAddresses as unknown[])
    : [];

  for (const entry of emails) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const rec = entry as Record<string, unknown>;
    if (primaryId && rec.id !== primaryId) {
      continue;
    }
    if (typeof rec.emailAddress === "string" && rec.emailAddress.trim().length > 0) {
      return rec.emailAddress.trim().toLowerCase();
    }
  }

  for (const entry of emails) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const rec = entry as Record<string, unknown>;
    if (typeof rec.emailAddress === "string" && rec.emailAddress.trim().length > 0) {
      return rec.emailAddress.trim().toLowerCase();
    }
  }

  return null;
};

const readDisplayName = (
  user: Record<string, unknown>,
  fallback: string,
  email: string | null
): string => {
  const first =
    typeof user.firstName === "string" ? user.firstName.trim() : "";
  const last =
    typeof user.lastName === "string" ? user.lastName.trim() : "";
  const full = `${first} ${last}`.trim();
  if (full) {
    return full;
  }

  if (typeof user.username === "string" && user.username.trim().length > 0) {
    return user.username.trim();
  }

  if (email) {
    return email;
  }

  return fallback;
};

export const verifyClerkRequest = async (
  request: IncomingMessage
): Promise<ClerkIdentity> => {
  const token = extractBearerToken(request);
  if (!token) {
    throw new ApiError(401, "UNAUTHENTICATED", "Missing Clerk bearer token.");
  }

  const secretKey = getClerkSecretKey();
  const authorizedParties = parseCsv(process.env.CLERK_AUTHORIZED_PARTIES);
  const audience = parseCsv(process.env.CLERK_AUDIENCE);
  const jwtKey = process.env.CLERK_JWT_KEY?.trim() || undefined;

  let payload: Record<string, unknown>;
  try {
    payload = (await verifyToken(token, {
      secretKey,
      jwtKey,
      authorizedParties: authorizedParties.length > 0 ? authorizedParties : undefined,
      audience: audience.length === 0 ? undefined : audience.length === 1 ? audience[0] : audience,
    })) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError(401, "UNAUTHENTICATED", `Invalid Clerk token: ${message}`);
  }

  const userId = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!userId) {
    throw new ApiError(401, "UNAUTHENTICATED", "Clerk token missing user subject.");
  }

  const expectedIssuer = loadConfig().clerkJwtIssuer.trim();
  if (expectedIssuer) {
    const issuer = typeof payload.iss === "string" ? payload.iss.trim() : "";
    if (!issuer || issuer !== expectedIssuer) {
      throw new ApiError(401, "UNAUTHENTICATED", "Clerk token issuer mismatch.");
    }
  }

  const clerkClient = createClerkClient({
    secretKey,
  });

  const user = (await clerkClient.users.getUser(userId)) as Record<string, unknown>;
  const email = readPrimaryEmail(user);
  const displayName = readDisplayName(user, userId, email);

  return {
    user_id: userId,
    display_name: displayName,
    email,
  };
};
