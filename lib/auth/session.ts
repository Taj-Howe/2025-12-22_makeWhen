import { getServerSession } from "next-auth";
import { authOptions } from "./auth";
import { getDb } from "../db/connection";

export const getSession = () => getServerSession(authOptions);

type RequireUserResult = {
  userId: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
};

export const requireUser = async (): Promise<RequireUserResult> => {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    throw new Error("UNAUTHORIZED");
  }
  const userId = session.user.id;

  const db = getDb();
  const user = await db
    .selectFrom("users")
    .select(["email", "name", "avatar_url"])
    .where("id", "=", userId)
    .executeTakeFirst();

  if (!user) {
    throw new Error("UNAUTHORIZED");
  }

  return {
    userId,
    email: user.email ?? null,
    name: user.name ?? null,
    avatarUrl: user.avatar_url ?? null,
  };
};
