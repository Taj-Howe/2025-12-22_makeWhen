import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authenticateRequest,
  type AuthenticatedRequest,
  type AuthContext,
} from "../auth/middleware.ts";
import { requireCsrfForCookieAuth } from "../auth/sessionSecurity.ts";
import {
  requireRoleAtLeast,
  requireTeamMember,
  type TeamRole,
} from "../auth/authz.ts";
import { ApiError } from "../auth/errors.ts";
import { queryRows, sqlLiteral } from "../db/client.ts";

type WriteJson = (
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>
) => void;

export type TeamRouteDependencies = {
  authenticateRequest: (request: AuthenticatedRequest) => Promise<AuthContext>;
  requireTeamMember: (user_id: string, team_id: string) => Promise<TeamRole>;
  requireRoleAtLeast: (role: TeamRole, requiredRole: TeamRole) => TeamRole;
};

const defaultDependencies: TeamRouteDependencies = {
  authenticateRequest: authenticateRequest(),
  requireTeamMember,
  requireRoleAtLeast,
};

const INVITE_DEFAULT_DAYS = 14;
const MAX_BODY_BYTES = 64 * 1024;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const parseRole = (value: unknown): TeamRole => {
  if (value === "owner" || value === "editor" || value === "viewer") {
    return value;
  }
  return "editor";
};

const parseEmail = (value: unknown) => {
  if (typeof value !== "string") {
    throw new ApiError(400, "BAD_REQUEST", "email is required.");
  }
  const email = value.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new ApiError(400, "BAD_REQUEST", "email must be valid.");
  }
  return email;
};

const readJsonBody = async (request: IncomingMessage) => {
  const chunks: Uint8Array[] = [];
  let total = 0;

  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += bytes.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body too large.");
    }
    chunks.push(bytes);
  }

  const bodyText = Buffer.concat(chunks).toString("utf8").trim();
  if (!bodyText) {
    return {} as Record<string, unknown>;
  }

  try {
    return JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "BAD_REQUEST", "Request body must be valid JSON.");
  }
};

const resolveRequestOrigin = (request: IncomingMessage) => {
  const proto = Array.isArray(request.headers["x-forwarded-proto"])
    ? request.headers["x-forwarded-proto"][0] ?? "https"
    : request.headers["x-forwarded-proto"] ?? "https";
  const host = Array.isArray(request.headers.host)
    ? request.headers.host[0] ?? ""
    : request.headers.host ?? "";
  if (!host) {
    return process.env.APP_BASE_URL?.trim() || "";
  }
  return `${proto}://${host}`;
};

const pathMatch = (pathname: string, pattern: RegExp) => {
  const match = pathname.match(pattern);
  if (!match) {
    return null;
  }
  return match;
};

const listTeamMembers = async (
  auth: AuthContext,
  teamId: string,
  deps: TeamRouteDependencies,
  writeJson: WriteJson,
  response: ServerResponse
) => {
  const role = await deps.requireTeamMember(auth.user_id, teamId);
  deps.requireRoleAtLeast(role, "viewer");

  const rows = await queryRows(
    `SELECT tm.user_id, tm.role, u.display_name, u.email
      FROM team_members tm
      JOIN users u ON u.user_id = tm.user_id
      WHERE tm.team_id = ${sqlLiteral(teamId)}
      ORDER BY
        CASE tm.role WHEN 'owner' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END,
        lower(u.display_name) ASC;`,
    ["user_id", "role", "display_name", "email"] as const
  );

  writeJson(response, 200, {
    team_id: teamId,
    members: rows.map((row) => ({
      user_id: row.user_id,
      display_name: row.display_name,
      email: row.email,
      role: parseRole(row.role),
    })),
  });
};

const listInvites = async (
  auth: AuthContext,
  teamId: string,
  deps: TeamRouteDependencies,
  writeJson: WriteJson,
  response: ServerResponse
) => {
  const role = await deps.requireTeamMember(auth.user_id, teamId);
  deps.requireRoleAtLeast(role, "viewer");

  await queryRows(
    `UPDATE team_invites
      SET status = 'expired'
      WHERE team_id = ${sqlLiteral(teamId)}
        AND status = 'pending'
        AND expires_at <= NOW();`,
    [] as const
  );

  const rows = await queryRows(
    `SELECT invite_id, invitee_email, role, status, expires_at, accepted_at, created_at
      FROM team_invites
      WHERE team_id = ${sqlLiteral(teamId)}
      ORDER BY created_at DESC
      LIMIT 100;`,
    [
      "invite_id",
      "invitee_email",
      "role",
      "status",
      "expires_at",
      "accepted_at",
      "created_at",
    ] as const
  );

  writeJson(response, 200, {
    team_id: teamId,
    invites: rows.map((row) => ({
      invite_id: row.invite_id,
      invitee_email: row.invitee_email,
      role: parseRole(row.role),
      status: row.status,
      expires_at: row.expires_at,
      accepted_at: row.accepted_at,
      created_at: row.created_at,
    })),
  });
};

const createInvite = async (
  request: IncomingMessage,
  auth: AuthContext,
  teamId: string,
  deps: TeamRouteDependencies,
  writeJson: WriteJson,
  response: ServerResponse
) => {
  const inviterRole = await deps.requireTeamMember(auth.user_id, teamId);
  deps.requireRoleAtLeast(inviterRole, "editor");

  const body = await readJsonBody(request);
  const inviteeEmail = parseEmail(body.email);
  const role = parseRole(body.role);

  if (role === "owner" && inviterRole !== "owner") {
    throw new ApiError(403, "INSUFFICIENT_ROLE", "Only owners can invite owners.");
  }

  const expiresDaysRaw = Number(body.expires_in_days ?? INVITE_DEFAULT_DAYS);
  const expiresDays =
    Number.isFinite(expiresDaysRaw) && expiresDaysRaw > 0
      ? Math.min(90, Math.floor(expiresDaysRaw))
      : INVITE_DEFAULT_DAYS;

  const inviteId = randomUUID();
  const inviteToken = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const tokenHash = sha256(inviteToken);

  try {
    await queryRows(
      `INSERT INTO team_invites (
          invite_id,
          team_id,
          inviter_user_id,
          invitee_email,
          role,
          token_hash,
          status,
          expires_at,
          created_at
        ) VALUES (
          ${sqlLiteral(inviteId)},
          ${sqlLiteral(teamId)},
          ${sqlLiteral(auth.user_id)},
          ${sqlLiteral(inviteeEmail)},
          ${sqlLiteral(role)},
          ${sqlLiteral(tokenHash)},
          'pending',
          NOW() + INTERVAL '${expiresDays} days',
          NOW()
        );`,
      [] as const
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("idx_team_invites_pending_unique")) {
      throw new ApiError(
        409,
        "BAD_REQUEST",
        "A pending invite already exists for this email."
      );
    }
    throw error;
  }

  const origin = resolveRequestOrigin(request);
  const inviteUrl = origin
    ? `${origin}/invite/${inviteToken}`
    : `/invite/${inviteToken}`;

  writeJson(response, 200, {
    invite: {
      invite_id: inviteId,
      team_id: teamId,
      invitee_email: inviteeEmail,
      role,
      invite_token: inviteToken,
      invite_url: inviteUrl,
      expires_in_days: expiresDays,
    },
  });
};

const revokeInvite = async (
  auth: AuthContext,
  teamId: string,
  inviteId: string,
  deps: TeamRouteDependencies,
  writeJson: WriteJson,
  response: ServerResponse
) => {
  const role = await deps.requireTeamMember(auth.user_id, teamId);
  deps.requireRoleAtLeast(role, "owner");

  await queryRows(
    `UPDATE team_invites
      SET status = 'revoked'
      WHERE invite_id = ${sqlLiteral(inviteId)}
        AND team_id = ${sqlLiteral(teamId)}
        AND status = 'pending';`,
    [] as const
  );

  writeJson(response, 200, {
    invite_id: inviteId,
    revoked: true,
  });
};

const acceptInvite = async (
  auth: AuthContext,
  inviteToken: string,
  writeJson: WriteJson,
  response: ServerResponse
) => {
  const tokenHash = sha256(inviteToken);

  await queryRows(
    `UPDATE team_invites
      SET status = 'expired'
      WHERE status = 'pending'
        AND expires_at <= NOW();`,
    [] as const
  );

  const inviteRows = await queryRows(
    `SELECT invite_id, team_id, invitee_email, role, status
      FROM team_invites
      WHERE token_hash = ${sqlLiteral(tokenHash)}
      LIMIT 1;`,
    ["invite_id", "team_id", "invitee_email", "role", "status"] as const
  );

  const invite = inviteRows[0];
  if (!invite) {
    throw new ApiError(404, "BAD_REQUEST", "Invite not found.");
  }
  if (invite.status !== "pending") {
    throw new ApiError(400, "BAD_REQUEST", "Invite is no longer pending.");
  }

  const userRows = await queryRows(
    `SELECT email FROM users WHERE user_id = ${sqlLiteral(auth.user_id)} LIMIT 1;`,
    ["email"] as const
  );
  const userEmail = userRows[0]?.email?.trim().toLowerCase() ?? "";
  if (!userEmail || userEmail !== (invite.invitee_email ?? "").trim().toLowerCase()) {
    throw new ApiError(403, "NOT_TEAM_MEMBER", "Invite email does not match current user.");
  }

  const role = parseRole(invite.role);

  await queryRows(
    `INSERT INTO team_members (team_id, user_id, role)
      VALUES (${sqlLiteral(invite.team_id ?? "")}, ${sqlLiteral(auth.user_id)}, ${sqlLiteral(role)})
      ON CONFLICT (team_id, user_id)
      DO UPDATE SET role = CASE WHEN team_members.role = 'owner' THEN 'owner' ELSE EXCLUDED.role END;`,
    [] as const
  );

  await queryRows(
    `UPDATE team_invites
      SET status = 'accepted', accepted_at = NOW()
      WHERE invite_id = ${sqlLiteral(invite.invite_id ?? "")};`,
    [] as const
  );

  writeJson(response, 200, {
    accepted: true,
    team_id: invite.team_id,
    role,
  });
};

export const handleTeamRoute = async (
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  writeJson: WriteJson,
  depsOverride: Partial<TeamRouteDependencies> = {}
) => {
  const deps = {
    ...defaultDependencies,
    ...depsOverride,
  };

  const method = request.method ?? "GET";

  const membersMatch = pathMatch(requestUrl.pathname, /^\/teams\/([^/]+)\/members$/);
  const invitesMatch = pathMatch(requestUrl.pathname, /^\/teams\/([^/]+)\/invites$/);
  const inviteRevokeMatch = pathMatch(
    requestUrl.pathname,
    /^\/teams\/([^/]+)\/invites\/([^/]+)\/revoke$/
  );
  const inviteAcceptMatch = pathMatch(requestUrl.pathname, /^\/invites\/([^/]+)\/accept$/);

  if (membersMatch && method === "GET") {
    const auth = await deps.authenticateRequest(request as AuthenticatedRequest);
    await listTeamMembers(
      auth,
      decodeURIComponent(membersMatch[1] ?? ""),
      deps,
      writeJson,
      response
    );
    return;
  }

  if (invitesMatch && method === "GET") {
    const auth = await deps.authenticateRequest(request as AuthenticatedRequest);
    await listInvites(
      auth,
      decodeURIComponent(invitesMatch[1] ?? ""),
      deps,
      writeJson,
      response
    );
    return;
  }

  if (invitesMatch && method === "POST") {
    const auth = await deps.authenticateRequest(request as AuthenticatedRequest);
    requireCsrfForCookieAuth(request, auth.auth_method);
    await createInvite(
      request,
      auth,
      decodeURIComponent(invitesMatch[1] ?? ""),
      deps,
      writeJson,
      response
    );
    return;
  }

  if (inviteRevokeMatch && method === "POST") {
    const auth = await deps.authenticateRequest(request as AuthenticatedRequest);
    requireCsrfForCookieAuth(request, auth.auth_method);
    await revokeInvite(
      auth,
      decodeURIComponent(inviteRevokeMatch[1] ?? ""),
      decodeURIComponent(inviteRevokeMatch[2] ?? ""),
      deps,
      writeJson,
      response
    );
    return;
  }

  if (inviteAcceptMatch && method === "POST") {
    const auth = await deps.authenticateRequest(request as AuthenticatedRequest);
    requireCsrfForCookieAuth(request, auth.auth_method);
    await acceptInvite(
      auth,
      decodeURIComponent(inviteAcceptMatch[1] ?? ""),
      writeJson,
      response
    );
    return;
  }

  throw new ApiError(404, "BAD_REQUEST", "Unknown team route.");
};
