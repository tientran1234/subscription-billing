/**
 * The language a workspace chose, written across to the gateway's own customer.
 *
 * Against a real Postgres because the customer this write lands on is resolved
 * from the tenant's own subscription rows — the same lookup the portal link and
 * the invoice history use — and the guarantee is that it is resolved from them
 * and never from the request. A stub for that lookup would test the stub.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { syncNoticeLocale } from "@/server/billing.service";
import { setTenantLocale, tenantLocale } from "@/server/tenant-locale";
import { FakeProvider } from "@/providers/fake";
import type { IBillingProvider } from "@/domain/billing-event";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("telling the gateway which language to write in", () => {
  let tenantId: string;

  beforeEach(async () => {
    await db.tenant.deleteMany();
    tenantId = (
      await db.tenant.create({ data: { email: `c${Date.now()}@example.test`, name: "Acme" } })
    ).id;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("writes the chosen language onto the customer the workspace is billed to", async () => {
    await db.subscription.create({
      data: { tenantId, planKey: "pro", status: "ACTIVE", customerRef: "cus_acme" },
    });
    const provider = new FakeProvider();

    expect(await syncNoticeLocale(provider, { tenantId, locale: "vi" })).toBe("recorded");
    expect(provider.customerLocales).toMatchObject([
      { customerRef: "cus_acme", preferredLocales: ["vi"] },
    ]);
  });

  it("tells the gateway nothing for a workspace that has never subscribed", async () => {
    const provider = new FakeProvider();

    // No customer exists to carry the column, and inventing one to write to
    // would be this app creating billing records for a workspace that has not
    // bought anything. The checkout they eventually open takes the language.
    expect(await syncNoticeLocale(provider, { tenantId, locale: "vi" })).toBe("no_customer");
    expect(provider.customerLocales).toEqual([]);
  });

  it("writes to the customer of the newest subscription, not another tenant's", async () => {
    const other = await db.tenant.create({
      data: { email: `o${Date.now()}@example.test`, name: "Other" },
    });
    await db.subscription.create({
      data: {
        tenantId: other.id,
        planKey: "pro",
        status: "ACTIVE",
        customerRef: "cus_other",
      },
    });
    await db.subscription.create({
      data: {
        tenantId,
        planKey: "pro",
        status: "ACTIVE",
        customerRef: "cus_acme",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await db.subscription.create({
      data: {
        tenantId,
        planKey: "pro",
        status: "ACTIVE",
        customerRef: "cus_acme_new",
        createdAt: new Date("2026-06-01T00:00:00Z"),
      },
    });
    const provider = new FakeProvider();

    await syncNoticeLocale(provider, { tenantId, locale: "en" });

    expect(provider.customerLocales).toMatchObject([{ customerRef: "cus_acme_new" }]);
  });

  it("keeps the workspace's own choice when the gateway refuses it", async () => {
    await db.subscription.create({
      data: { tenantId, planKey: "pro", status: "ACTIVE", customerRef: "cus_acme" },
    });
    // The column is ours and the gateway's copy is ours to ask for, so the half
    // we can guarantee must not be lost to the half we cannot. This is the
    // order the route depends on: write, then ask.
    const refusing: IBillingProvider = Object.assign(new FakeProvider(), {
      setCustomerLocale: async () => {
        throw new Error("gateway down");
      },
    });

    await setTenantLocale(tenantId, "vi");

    expect(await syncNoticeLocale(refusing, { tenantId, locale: "vi" })).toBe("unavailable");
    expect(await tenantLocale(tenantId)).toBe("vi");
  });
});
