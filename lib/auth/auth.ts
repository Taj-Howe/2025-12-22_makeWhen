import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { getDb } from "../db/connection";

type ProvisionInput = {
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  provider: string;
  providerSubject: string;
};

const provisionUser = async ({
  email,
  name,
  avatarUrl,
  provider,
  providerSubject,
}: ProvisionInput) => {
  const db = getDb();

  return db.transaction().execute(async (trx) => {
    const existingIdentity = await trx
      .selectFrom("auth_identities")
      .select(["user_id"])
      .where("provider", "=", provider)
      .where("provider_subject", "=", providerSubject)
      .executeTakeFirst();

    if (existingIdentity?.user_id) {
      return existingIdentity.user_id;
    }

    let userId: string | null = null;
    if (email) {
      const existingUser = await trx
        .selectFrom("users")
        .select(["id"])
        .where("email", "=", email)
        .executeTakeFirst();
      userId = existingUser?.id ?? null;
    }

    if (!userId) {
      const inserted = await trx
        .insertInto("users")
        .values({
          email,
          name,
          avatar_url: avatarUrl,
        })
        .returning("id")
        .executeTakeFirst();
      userId = inserted?.id ?? null;
    }

    if (!userId) {
      throw new Error("Failed to provision user");
    }

    await trx
      .insertInto("auth_identities")
      .values({
        user_id: userId,
        provider,
        provider_subject: providerSubject,
      })
      .execute();

    return userId;
  });
};

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (token.userId) {
        return token;
      }
      if (!account || !profile || account.provider !== "google") {
        return token;
      }
      const providerSubject =
        typeof (profile as { sub?: string }).sub === "string"
          ? (profile as { sub: string }).sub
          : "";
      if (!providerSubject) {
        return token;
      }
      const userId = await provisionUser({
        email:
          typeof (profile as { email?: string }).email === "string"
            ? (profile as { email: string }).email
            : null,
        name:
          typeof (profile as { name?: string }).name === "string"
            ? (profile as { name: string }).name
            : null,
        avatarUrl:
          typeof (profile as { picture?: string }).picture === "string"
            ? (profile as { picture: string }).picture
            : null,
        provider: account.provider,
        providerSubject,
      });
      return { ...token, userId };
    },
    async session({ session, token }) {
      if (token.userId) {
        session.user = {
          ...session.user,
          id: token.userId as string,
        };
      }
      return session;
    },
  },
  secret: process.env.AUTH_SECRET,
};
