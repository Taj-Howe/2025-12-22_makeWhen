import { mutate, query } from "../rpc/clientSingleton";
import type {
  AuthLogoutResult,
  AuthSessionBootstrapArgs,
  AuthSessionCurrentResult,
  AuthSessionOptionsResult,
  AuthSessionSetArgs,
  TeamRole,
} from "../rpc/types";
import {
  AUTH_MODE,
  AUTH_OAUTH_CALLBACK_PATH,
  AUTH_REMOTE_BASE_URL,
  type AuthMode,
} from "./authConfig";

export type SignInArgs = {
  user_id?: string;
  team_id?: string;
};

export type SignInResult = {
  status: "signed_in" | "picker_required";
  session: AuthSessionCurrentResult | null;
};

export interface AuthProvider {
  mode: AuthMode;
  getSession: () => Promise<AuthSessionCurrentResult>;
  signIn: (args?: SignInArgs) => Promise<SignInResult>;
  signOut: () => Promise<AuthLogoutResult>;
}

type RemoteMembership = {
  team_id: string;
  team_name: string;
  role: TeamRole;
};

type RemoteSessionResponse = {
  authenticated: boolean;
  session?: {
    session_id: string;
    user_id: string;
    team_id: string;
  };
  user?: {
    user_id: string;
    display_name: string;
    avatar_url?: string | null;
  };
  team?: {
    team_id: string;
    name: string;
  };
  role?: TeamRole;
  memberships?: RemoteMembership[];
};

const getLocalSession = async () =>
  query<AuthSessionCurrentResult>("auth.session.current", {});

const isBrowser = () => typeof window !== "undefined";

const normalizeBaseUrl = (value: string) => value.trim().replace(/\/$/, "");

const resolveAuthBaseUrl = () => {
  const explicit = normalizeBaseUrl(AUTH_REMOTE_BASE_URL);
  if (explicit) {
    return explicit;
  }
  if (isBrowser()) {
    return normalizeBaseUrl(window.location.origin);
  }
  return "";
};

const toRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const parseTeamRole = (value: unknown): TeamRole => {
  if (value === "owner" || value === "editor" || value === "viewer") {
    return value;
  }
  return "viewer";
};

const parseRemoteSession = (value: unknown): RemoteSessionResponse | null => {
  const rec = toRecord(value);
  if (!rec || typeof rec.authenticated !== "boolean") {
    return null;
  }
  if (!rec.authenticated) {
    return { authenticated: false };
  }

  const session = toRecord(rec.session);
  const user = toRecord(rec.user);
  const team = toRecord(rec.team);
  if (
    !session ||
    typeof session.session_id !== "string" ||
    typeof session.user_id !== "string" ||
    typeof session.team_id !== "string" ||
    !user ||
    typeof user.user_id !== "string" ||
    typeof user.display_name !== "string" ||
    !team ||
    typeof team.team_id !== "string" ||
    typeof team.name !== "string"
  ) {
    return null;
  }

  const membershipsRaw = Array.isArray(rec.memberships) ? rec.memberships : [];
  const memberships: RemoteMembership[] = [];
  for (const membership of membershipsRaw) {
    const item = toRecord(membership);
    if (!item || typeof item.team_id !== "string") {
      continue;
    }
    const teamName =
      typeof item.team_name === "string" && item.team_name.trim().length > 0
        ? item.team_name.trim()
        : item.team_id;
    memberships.push({
      team_id: item.team_id,
      team_name: teamName,
      role: parseTeamRole(item.role),
    });
  }

  return {
    authenticated: true,
    session: {
      session_id: session.session_id,
      user_id: session.user_id,
      team_id: session.team_id,
    },
    user: {
      user_id: user.user_id,
      display_name: user.display_name,
      avatar_url: typeof user.avatar_url === "string" ? user.avatar_url : null,
    },
    team: {
      team_id: team.team_id,
      name: team.name,
    },
    role: parseTeamRole(rec.role),
    memberships,
  };
};

const fetchRemoteSession = async (): Promise<RemoteSessionResponse> => {
  const baseUrl = resolveAuthBaseUrl();
  if (!baseUrl) {
    throw new Error(
      "AUTH_REMOTE_BASE_URL is required for AUTH_MODE=oauth when not running in a browser origin context."
    );
  }

  const response = await fetch(`${baseUrl}/auth/session`, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`OAuth session request failed (${response.status}).`);
  }

  const parsed = parseRemoteSession((await response.json()) as unknown);
  if (!parsed) {
    throw new Error("Invalid OAuth session response shape.");
  }
  return parsed;
};

const toSafePath = (candidate: string | null) => {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) {
    return "/";
  }
  return candidate;
};

const finalizeOAuthCallbackRoute = () => {
  if (!isBrowser()) {
    return;
  }
  if (window.location.pathname !== AUTH_OAUTH_CALLBACK_PATH) {
    return;
  }
  const params = new URLSearchParams(window.location.search);
  const next = toSafePath(params.get("next"));
  window.history.replaceState({}, "", next);
};

const bootstrapLocalSessionFromRemote = async (remote: RemoteSessionResponse) => {
  if (!remote.authenticated || !remote.session || !remote.user || !remote.team) {
    await mutate<AuthLogoutResult>("auth.logout", {});
    return;
  }

  const payload: AuthSessionBootstrapArgs = {
    user_id: remote.user.user_id,
    display_name: remote.user.display_name,
    avatar_url: remote.user.avatar_url ?? null,
    team_id: remote.team.team_id,
    team_name: remote.team.name,
    role: remote.role ?? "editor",
    memberships: remote.memberships?.map((membership) => ({
      team_id: membership.team_id,
      team_name: membership.team_name,
      role: membership.role,
    })),
  };

  await mutate("auth.session.bootstrap", payload);
};

const localProvider: AuthProvider = {
  mode: "local",
  getSession: getLocalSession,
  signIn: async (args) => {
    const userId =
      typeof args?.user_id === "string" ? args.user_id.trim() : "";
    const teamId =
      typeof args?.team_id === "string" ? args.team_id.trim() : "";
    if (!userId || !teamId) {
      return {
        status: "picker_required",
        session: await getLocalSession(),
      };
    }
    const payload: AuthSessionSetArgs = {
      user_id: userId,
      team_id: teamId,
    };
    await mutate("auth.session.set", payload);
    return {
      status: "signed_in",
      session: await getLocalSession(),
    };
  },
  signOut: () => mutate<AuthLogoutResult>("auth.logout", {}),
};

const oauthProvider: AuthProvider = {
  mode: "oauth",
  getSession: async () => {
    const remote = await fetchRemoteSession();
    await bootstrapLocalSessionFromRemote(remote);
    finalizeOAuthCallbackRoute();
    return getLocalSession();
  },
  signIn: async (args) => {
    const userId =
      typeof args?.user_id === "string" ? args.user_id.trim() : "";
    const teamId =
      typeof args?.team_id === "string" ? args.team_id.trim() : "";

    if (userId && teamId) {
      await mutate("auth.session.set", {
        user_id: userId,
        team_id: teamId,
      } satisfies AuthSessionSetArgs);
      return {
        status: "signed_in",
        session: await getLocalSession(),
      };
    }

    if (!isBrowser()) {
      throw new Error("OAuth sign-in requires a browser runtime.");
    }

    const baseUrl = resolveAuthBaseUrl();
    if (!baseUrl) {
      throw new Error("AUTH_REMOTE_BASE_URL is required for OAuth sign-in.");
    }

    const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const callbackUrl = `${window.location.origin}${AUTH_OAUTH_CALLBACK_PATH}?next=${encodeURIComponent(
      toSafePath(currentPath)
    )}`;
    const startUrl = `${baseUrl}/auth/oauth/start?return_to=${encodeURIComponent(
      callbackUrl
    )}`;

    window.location.assign(startUrl);

    return {
      status: "picker_required",
      session: await getLocalSession(),
    };
  },
  signOut: async () => {
    const baseUrl = resolveAuthBaseUrl();
    if (baseUrl) {
      await fetch(`${baseUrl}/auth/logout`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
        },
      }).catch(() => {
        // Keep local sign-out resilient even if remote sign-out fails.
      });
    }
    return mutate<AuthLogoutResult>("auth.logout", {});
  },
};

export const authProvider: AuthProvider =
  AUTH_MODE === "oauth" ? oauthProvider : localProvider;

export const getSessionOptions = async (): Promise<AuthSessionOptionsResult> =>
  query<AuthSessionOptionsResult>("auth.session.options", {});
