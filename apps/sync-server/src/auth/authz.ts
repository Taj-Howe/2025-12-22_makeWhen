import { queryRows, sqlLiteral } from "../db/client.ts";
import { ApiError } from "./errors.ts";

export type TeamRole = "owner" | "editor" | "viewer";

const ROLE_ORDER: Record<TeamRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

export const requireRoleAtLeast = (
  role: TeamRole,
  requiredRole: TeamRole
): TeamRole => {
  if (ROLE_ORDER[role] >= ROLE_ORDER[requiredRole]) {
    return role;
  }
  throw new ApiError(
    403,
    "INSUFFICIENT_ROLE",
    `Role ${role} cannot perform action requiring ${requiredRole}.`
  );
};

export const requireTeamMember = async (
  user_id: string,
  team_id: string
): Promise<TeamRole> => {
  const rows = await queryRows(
    `SELECT role
     FROM team_members
     WHERE team_id = ${sqlLiteral(team_id)}
       AND user_id = ${sqlLiteral(user_id)}
     LIMIT 1;`,
    ["role"] as const
  );
  const role = rows[0]?.role;

  if (role === "owner" || role === "editor" || role === "viewer") {
    return role;
  }

  throw new ApiError(
    403,
    "NOT_TEAM_MEMBER",
    "User is not a member of the requested team."
  );
};
