import { describe, expect, it } from "vitest";
import { portalCustomerFor } from "@/domain/portal";

const at = (iso: string, customerRef: string | null) => ({
  customerRef,
  createdAt: new Date(iso),
});

describe("portal customer", () => {
  it("has nothing to open for a tenant that never reached checkout", () => {
    expect(portalCustomerFor([])).toBeNull();
  });

  it("ignores a subscription whose first webhook has not landed yet", () => {
    expect(portalCustomerFor([at("2026-01-01", null)])).toBeNull();
  });

  it("opens for the newest customer, not the newest subscription", () => {
    // The PENDING retry is the newest row, but Stripe has not told us its
    // customer yet; the portal still has to open for the one that is billing.
    const customer = portalCustomerFor([
      at("2026-01-01", "cus_old"),
      at("2026-06-01", "cus_current"),
      at("2026-07-01", null),
    ]);
    expect(customer).toBe("cus_current");
  });

  it("still opens for a tenant whose subscriptions have all lapsed", () => {
    // Cancelled customers are exactly who needs invoices and a card update.
    expect(portalCustomerFor([at("2026-01-01", "cus_churned")])).toBe("cus_churned");
  });
});
