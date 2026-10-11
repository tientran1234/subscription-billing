import NextAuth from "next-auth";
import Nodemailer from "next-auth/providers/nodemailer";
import { PrismaAdapter } from "@auth/prisma-adapter";
import type { Membership } from "@/domain/membership";
import { roleFrom } from "@/domain/role";
import { acceptOpenInvites } from "@/server/invites";
import { db } from "./db";
import { authEnv } from "./env";

declare module "next-auth" {
  interface Session {
    /**
     * Every tenant this user may act for and what they may do in each,
     * carried on the session itself.
     *
     * The role is here rather than read per request because it is read on
     * every one: the route wrapper refuses a change with it and the account
     * page withholds buttons with it. Sessions are rows in Postgres and this
     * callback runs against them, so a role changed in one workspace is in
     * force on the person's next request — the same promise removing them from
     * it makes.
     */
    memberships: Membership[];
  }
}

/**
 * Magic-link sign-in. No password to leak, no OAuth app to register — the
 * mailbox is the credential, which is the right trade for a billing console
 * whose users are already reachable by email.
 *
 * The config is a function so the SMTP settings are read on the first auth
 * request rather than at import time: `next build` runs without secrets.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const e = authEnv();
  return {
    adapter: PrismaAdapter(db),
    providers: [Nodemailer({ server: e.EMAIL_SERVER, from: e.EMAIL_FROM })],
    // Sessions live in Postgres, not in a JWT: signing someone out, or
    // removing them from a tenant, then takes effect on their next request
    // instead of whenever their token happens to expire.
    session: { strategy: "database" },
    callbacks: {
      async session({ session, user }) {
        session.user.id = user.id;
        const memberships = await db.membership.findMany({
          where: { userId: user.id },
          select: { tenantId: true, role: true },
        });
        session.memberships = memberships.map((m) => ({
          tenantId: m.tenantId,
          role: roleFrom(m.role),
        }));
        return session;
      },
    },
    events: {
      async createUser({ user }) {
        if (!user.id || !user.email) return;
        // An invited address joins the workspace that invited it rather than
        // getting one of its own. A personal tenant alongside would make the
        // session ambiguous from its first request — two memberships and no
        // picker — and would leave the seat the invite is holding spent on a
        // workspace the person was never offered.
        if ((await acceptOpenInvites({ userId: user.id, email: user.email })) > 0) return;

        // A first sign-in has to land somewhere, or the account exists with
        // nothing it may act for. An upsert rather than a create so that
        // signing in at an address a tenant was already seeded with joins
        // that tenant instead of failing on the unique email.
        const tenant = await db.tenant.upsert({
          where: { email: user.email },
          create: { email: user.email, name: user.email.split("@")[0] },
          update: {},
        });
        // An admin, stated rather than left to the column's default: this is
        // the workspace's first and only member, and a workspace whose one
        // person could not change it would be unusable from the moment it
        // existed.
        await db.membership.create({
          data: { userId: user.id, tenantId: tenant.id, role: "admin" },
        });
      },
      async signIn({ user }) {
        if (!user.id || !user.email) return;
        // The accept path for an address that already had an account when it
        // was invited: `createUser` never fires for it, so without this the
        // invite would sit open until it expired. Idempotent, so the new user
        // above running it first costs nothing — the claim on each invite row
        // is what decides, not which event got there.
        await acceptOpenInvites({ userId: user.id, email: user.email });
      },
    },
  };
});
