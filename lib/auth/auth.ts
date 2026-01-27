import type { NextAuthOptions } from "next-auth";
import { getServerSession } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { db } from "../db/kysely";

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    }),
  ],
  secret: process.env.AUTH_SECRET,
  session: { strategy: "jwt" },
};

const ensureUser = async (email: string, name?: string | null, image?: string | null) => {
  const existing = await db
    .selectFrom("users")
    .select(["id", "email", "name", "image"])
    .where("email", "=", email)
    .executeTakeFirst();

  if (existing) {
    const needsUpdate =
      (name && existing.name !== name) ||
      (image && existing.image !== image);
    if (needsUpdate) {
      await db
        .updateTable("users")
        .set({
          name: name ?? existing.name,
          image: image ?? existing.image,
        })
        .where("id", "=", existing.id)
        .execute();
    }
    return existing;
  }

  const inserted = await db
    .insertInto("users")
    .values({
      email,
      name: name ?? null,
      image: image ?? null,
    })
    .returning(["id", "email", "name", "image"])
    .executeTakeFirstOrThrow();

  return inserted;
};

export const requireUser = async () => {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) {
    throw new Error("Unauthorized");
  }

  const user = await ensureUser(
    email,
    session?.user?.name ?? null,
    session?.user?.image ?? null
  );

  return {
    userId: user.id,
    email: user.email,
    name: user.name ?? session?.user?.name ?? null,
    avatarUrl: user.image ?? session?.user?.image ?? null,
  };
};
