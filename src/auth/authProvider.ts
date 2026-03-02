import { mutate, query } from "../rpc/clientSingleton";
import type {
  AuthLogoutResult,
  AuthSessionBootstrapArgs,
  AuthSessionCurrentResult,
  AuthSessionOptionsResult,
  AuthSessionSetArgs,
  TeamRole,
} from "../rpc/types";
import { AUTH_MODE, AUTH_REMOTE_BASE_URL, type AuthMode } from "./authConfig";
import { readClerkBridge } from "./clerkBridge";

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

const readCookie = (name: string) => {
  if (typeof document === "undefined") {
    return "";
  }
  const entries = document.cookie.split(";").map((part) => part.trim());
  for (const entry of entries) {
    if (!entry.startsWith(`${name}=`)) {
      continue;
    }
    return decodeURIComponent(entry.slice(name.length + 1));
  }
  return "";
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

const fetchRemoteSession = async (
  teamId?: string | null
): Promise<RemoteSessionResponse> => {
  const baseUrl = resolveAuthBaseUrl();
  if (!baseUrl) {
    throw new Error(
      "AUTH_REMOTE_BASE_URL is required for AUTH_MODE=clerk when not running in a browser origin context."
    );
  }

  const search = new URLSearchParams();
  const normalizedTeamId = typeof teamId === "string" ? teamId.trim() : "";
  if (normalizedTeamId) {
    search.set("team_id", normalizedTeamId);
  }
  const suffix = search.toString();
  const response = await fetch(`${baseUrl}/auth/session${suffix ? `?${suffix}` : ""}`, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Clerk session request failed (${response.status}).`);
  }

  const parsed = parseRemoteSession((await response.json()) as unknown);
  if (!parsed) {
    throw new Error("Invalid Clerk session response shape.");
  }
  return parsed;
};

const exchangeClerkSession = async (token: string): Promise<void> => {
  const baseUrl = resolveAuthBaseUrl();
  if (!baseUrl) {
    throw new Error("AUTH_REMOTE_BASE_URL is required for Clerk session exchange.");
  }

  const response = await fetch(`${baseUrl}/auth/clerk/exchange`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { message?: string }
      | null;
    const message = payload?.message ?? `HTTP ${response.status}`;
    throw new Error(`Clerk session exchange failed: ${message}`);
  }
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

const clerkProvider: AuthProvider = {
  mode: "clerk",
  getSession: async () => {
    const bridge = readClerkBridge();
    if (!bridge || !bridge.isLoaded) {
      return getLocalSession();
    }

    if (!bridge.isSignedIn) {
      await mutate<AuthLogoutResult>("auth.logout", {});
      return getLocalSession();
    }

    const token = await bridge.getToken();
    if (!token) {
      await mutate<AuthLogoutResult>("auth.logout", {});
      return getLocalSession();
    }

    await exchangeClerkSession(token);
    const local = await getLocalSession();
    const remote = await fetchRemoteSession(local.session?.team_id ?? null);
    await bootstrapLocalSessionFromRemote(remote);
    return getLocalSession();
  },
  signIn: async (args) => {
    const bridge = readClerkBridge();
    if (!bridge || !bridge.isLoaded) {
      throw new Error("Clerk is not initialized yet.");
    }

    if (!bridge.isSignedIn) {
      bridge.openSignIn();
      return {
        status: "picker_required",
        session: await getLocalSession(),
      };
    }

    const token = await bridge.getToken();
    if (!token) {
      bridge.openSignIn();
      return {
        status: "picker_required",
        session: await getLocalSession(),
      };
    }

    await exchangeClerkSession(token);
    const requestedTeamId =
      typeof args?.team_id === "string" ? args.team_id.trim() : "";
    const remote = await fetchRemoteSession(requestedTeamId || null);
    await bootstrapLocalSessionFromRemote(remote);
    return {
      status: "signed_in",
      session: await getLocalSession(),
    };
  },
  signOut: async () => {
    const bridge = readClerkBridge();
    if (bridge?.isLoaded) {
      await bridge.signOut();
    }

    const baseUrl = resolveAuthBaseUrl();
    if (baseUrl) {
      const csrf = readCookie("mw_csrf");
      await fetch(`${baseUrl}/auth/logout`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        },
      }).catch(() => {
        // Keep local sign-out resilient even if remote sign-out fails.
      });
    }
    return mutate<AuthLogoutResult>("auth.logout", {});
  },
};

export const authProvider: AuthProvider =
  AUTH_MODE === "clerk" ? clerkProvider : localProvider;

export const getSessionOptions = async (): Promise<AuthSessionOptionsResult> =>
  query<AuthSessionOptionsResult>("auth.session.options", {});

export const getAuthRemoteBaseUrl = () => resolveAuthBaseUrl();
