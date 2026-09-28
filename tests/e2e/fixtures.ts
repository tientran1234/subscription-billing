/**
 * A signed-in workspace and a clock, per test.
 *
 * Signing in writes the row Auth.js's adapter would have written and hands the
 * browser its token. A magic link needs a mailbox to click it out of, and the
 * thing under test here is billing — routing an SMTP catcher through CI would
 * buy coverage of sign-in, which the session tests already have.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { test as base } from "@playwright/test";
import { db } from "@/lib/db";
import { BASE_URL } from "./app";
import { BillingClock } from "./clock";

/** Auth.js's session cookie over http; `__Secure-` prefixed over https. */
const SESSION_COOKIE = "authjs.session-token";

const SESSION_DAYS = 30;

export interface Workspace {
  tenantId: string;
  email: string;
  /** A gateway-side id no other test can be using. */
  ref(kind: string): string;
}

export const test = base.extend<{ tag: string; workspace: Workspace; clock: BillingClock }>({
  tag: async ({}, use) => {
    await use(randomBytes(6).toString("hex"));
  },

  workspace: async ({ context, tag }, use) => {
    const email = `e2e-${tag}@example.test`;
    const user = await db.user.create({ data: { email, emailVerified: new Date() } });
    const tenant = await db.tenant.create({ data: { email, name: `e2e ${tag}` } });
    await db.membership.create({ data: { userId: user.id, tenantId: tenant.id } });

    const sessionToken = randomUUID();
    await db.session.create({
      data: {
        sessionToken,
        userId: user.id,
        expires: new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000),
      },
    });
    await context.addCookies([{ name: SESSION_COOKIE, value: sessionToken, url: BASE_URL }]);

    await use({ tenantId: tenant.id, email, ref: (kind) => `${kind}_${tag}` });

    // Cascades take the session, the membership and everything billed.
    await db.user.delete({ where: { id: user.id } });
    await db.tenant.delete({ where: { id: tenant.id } });
  },

  clock: async ({ request }, use) => {
    const clock = new BillingClock(request);
    await use(clock);
    // Nothing references these rows, so nothing cascades them away.
    await db.webhookEvent.deleteMany({
      where: { providerEventId: { startsWith: clock.eventIdPrefix } },
    });
  },
});

// One client per worker, closed when its last file is done: Postgres refuses
// new connections long before a suite this size would otherwise stop opening them.
test.afterAll(async () => {
  await db.$disconnect();
});

export { expect } from "@playwright/test";
