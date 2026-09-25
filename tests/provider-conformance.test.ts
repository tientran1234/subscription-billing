/**
 * Every provider must pass this suite unchanged. That is what makes "swap the
 * gateway without touching business logic" a fact instead of a hope.
 */
import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { WebhookVerificationError, type IBillingProvider } from "@/domain/billing-event";
import { FakeProvider } from "@/providers/fake";
import { StripeProvider, normalize } from "@/providers/stripe";

function contract(name: string, make: () => IBillingProvider) {
  describe(name, () => {
    it("rejects a webhook whose signature does not match", async () => {
      const provider = make();
      await expect(
        provider.verifyWebhook('{"providerEventId":"evt_1"}', "not-a-signature"),
      ).rejects.toBeInstanceOf(WebhookVerificationError);
    });

    // The list is exhaustive on purpose. A subscription's status may only
    // change through the state machine in applyEvent, so the only way this app
    // is allowed to offer a cancel or a card update is by handing the customer
    // a link to the provider's own portal. An adapter growing a
    // `cancelSubscription` would be a second writer, and fails here.
    //
    // `changePlan` is on the list because it is not one: it moves a price, and
    // the plan it moves to reaches us on the invoice that pays for it, like
    // every other fact.
    it("exposes no way to change a subscription's status", () => {
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(make()))
        .filter((m) => m !== "constructor" && !EXTRAS[name]?.includes(m))
        .sort();
      expect(methods).toEqual([
        "changePlan",
        "createCheckout",
        "createPortalSession",
        "previewPlanChange",
        "verifyWebhook",
      ]);
    });
  });
}

/** Helpers a provider may add for the tests — never part of the contract. */
const EXTRAS: Record<string, string[]> = { fake: ["sign"] };

contract("fake", () => new FakeProvider());
contract("stripe", () => new StripeProvider("sk_test_x", "whsec_x"));

describe("fake provider", () => {
  it("round-trips a signed event", async () => {
    const provider = new FakeProvider();
    const body = JSON.stringify({
      providerEventId: "evt_1",
      type: "subscription_activated",
      providerRef: "sub_1",
    });
    const event = await provider.verifyWebhook(body, provider.sign(body));
    expect(event).toMatchObject({ providerEventId: "evt_1", type: "subscription_activated" });
  });

  it("returns a portal url for the customer it was asked about", async () => {
    const { portalUrl } = await new FakeProvider().createPortalSession({
      customerRef: "cus_local",
      returnUrl: "https://x/account",
    });
    expect(portalUrl).toMatch(/^https?:\/\//);
    expect(portalUrl).toContain("cus_local");
  });

  it("bills the plan change as of the instant it quoted", async () => {
    const provider = new FakeProvider();
    const preview = await provider.previewPlanChange({
      providerRef: "sub_1",
      priceRef: "price_scale",
    });
    const { prorationDate } = preview;

    expect(preview.amountDueMinor).toBeTypeOf("number");
    // The instant the quote was computed at: confirming sends it back, which is
    // what stops the customer being billed for a price they were never shown.
    expect(prorationDate.getTime()).toBeLessThanOrEqual(Date.now());

    await provider.changePlan({
      providerRef: "sub_1",
      priceRef: "price_scale",
      planKey: "scale",
      prorationDate,
    });

    expect(provider.planChanges).toHaveLength(1);
    expect(provider.planChanges[0].prorationDate).toEqual(prorationDate);
  });

  it("returns a checkout url and a reference", async () => {
    const result = await new FakeProvider().createCheckout({
      subscriptionId: "sub_local",
      planKey: "pro",
      priceRef: "price_x",
      successUrl: "https://x/ok",
      cancelUrl: "https://x/no",
    });
    expect(result.checkoutUrl).toMatch(/^https?:\/\//);
    expect(result.checkoutRef).toBeTruthy();
  });
});

const stripeEvent = (type: string, object: unknown) =>
  ({ id: "evt_stripe_1", type, data: { object } }) as unknown as Stripe.Event;

describe("stripe normalisation", () => {
  it("activates from a completed checkout and carries both refs", () => {
    const event = normalize(
      stripeEvent("checkout.session.completed", {
        id: "cs_1",
        subscription: "sub_1",
        customer: "cus_1",
        metadata: { planKey: "pro" },
      }),
    );
    expect(event).toMatchObject({
      type: "subscription_activated",
      checkoutRef: "cs_1",
      providerRef: "sub_1",
      customerRef: "cus_1",
      planKey: "pro",
    });
  });

  it("reads an expanded subscription object, not just an id", () => {
    const event = normalize(
      stripeEvent("checkout.session.completed", { id: "cs_2", subscription: { id: "sub_2" } }),
    );
    expect(event.providerRef).toBe("sub_2");
  });

  it("turns a paid invoice into a renewal with a period end", () => {
    const end = 1_800_000_000;
    const event = normalize(
      stripeEvent("invoice.paid", {
        subscription: "sub_3",
        lines: { data: [{ period: { end } }] },
      }),
    );
    expect(event.type).toBe("subscription_activated");
    expect(event.currentPeriodEnd?.getTime()).toBe(end * 1000);
  });

  // A plan change is only ever reported to us this way: Stripe snapshots the
  // subscription's metadata onto the invoice it finalizes, so the paid invoice
  // names the plan the money was taken for. Drop this and an upgrade the
  // customer paid for never reaches their entitlements.
  it("carries the plan a paid invoice was raised for", () => {
    const event = normalize(
      stripeEvent("invoice.paid", {
        subscription: "sub_9",
        subscription_details: { metadata: { planKey: "scale" } },
      }),
    );
    expect(event.planKey).toBe("scale");
  });

  it("maps a failed invoice to payment_failed", () => {
    expect(normalize(stripeEvent("invoice.payment_failed", { subscription: "sub_4" }))).toMatchObject(
      { type: "payment_failed", providerRef: "sub_4" },
    );
  });

  it("maps a deleted subscription to cancelled", () => {
    expect(
      normalize(stripeEvent("customer.subscription.deleted", { id: "sub_5" })),
    ).toMatchObject({ type: "subscription_canceled", providerRef: "sub_5" });
  });

  // The customer id reaches us on webhooks and nowhere else, so every event
  // that carries one has to surface it — miss one and a tenant whose only
  // event was a renewal or a failed payment can never open the portal.
  it("carries the customer id on renewals and failed payments too", () => {
    expect(
      normalize(stripeEvent("invoice.paid", { subscription: "sub_6", customer: "cus_6" }))
        .customerRef,
    ).toBe("cus_6");
    expect(
      normalize(
        stripeEvent("invoice.payment_failed", { subscription: "sub_7", customer: "cus_7" }),
      ).customerRef,
    ).toBe("cus_7");
    expect(
      normalize(stripeEvent("customer.subscription.deleted", { id: "sub_8", customer: "cus_8" }))
        .customerRef,
    ).toBe("cus_8");
  });

  it("marks anything it does not handle as unknown rather than guessing", () => {
    expect(normalize(stripeEvent("customer.created", { id: "cus_1" })).type).toBe("unknown");
  });
});
