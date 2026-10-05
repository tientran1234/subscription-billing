/**
 * Every provider must pass this suite unchanged. That is what makes "swap the
 * gateway without touching business logic" a fact instead of a hope.
 */
import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { WebhookVerificationError, type IBillingProvider } from "@/domain/billing-event";
import { FakeProvider } from "@/providers/fake";
import {
  StripeProvider,
  licensedItemOf,
  meteredItemOf,
  normalize,
} from "@/providers/stripe";

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
    // every other fact. `fetchEvent` only reads: it hands business logic an
    // event the provider already delivered, which is what a replay re-applies.
    // `reportUsage` tells the provider what to put on its next invoice and
    // decides nothing: what is owed is computed before it is called, and
    // whether the month has been reported is a claim in our own tables.
    it("exposes no way to change a subscription's status", () => {
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(make()))
        .filter((m) => m !== "constructor" && !EXTRAS[name]?.includes(m))
        .sort();
      expect(methods).toEqual([
        "changePlan",
        "createCheckout",
        "createPortalSession",
        "fetchEvent",
        "previewPlanChange",
        "reportUsage",
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

  it("hands back an event it delivered, and nothing for an id it never sent", async () => {
    const provider = new FakeProvider();
    const body = JSON.stringify({
      providerEventId: "evt_replay",
      type: "payment_failed",
      providerRef: "sub_1",
    });
    await provider.verifyWebhook(body, provider.sign(body));

    // The same event, so a replay cannot apply something the delivery did not.
    await expect(provider.fetchEvent("evt_replay")).resolves.toMatchObject({
      providerEventId: "evt_replay",
      type: "payment_failed",
      providerRef: "sub_1",
    });
    // Null rather than a throw: an id the gateway has nothing under is how a
    // mistyped replay arrives, and the rule in domain/replay.ts refuses it.
    await expect(provider.fetchEvent("evt_never_sent")).resolves.toBeNull();
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

  it("reports the units it is handed, under the period they were counted in", async () => {
    const provider = new FakeProvider();
    await provider.reportUsage({ providerRef: "sub_1", quantity: 500, period: "2026-09" });

    // The period rides along so a second report of the same month is a no-op
    // at the gateway too, not only against our own claim.
    expect(provider.usageReports).toMatchObject([
      { providerRef: "sub_1", quantity: 500, period: "2026-09" },
    ]);
  });

  it("asks the gateway for the metered add-on when the plan sells one", async () => {
    const provider = new FakeProvider();
    await provider.createCheckout({
      subscriptionId: "sub_metered",
      planKey: "pro",
      priceRef: "price_pro",
      overagePriceRef: "price_overage",
      successUrl: "https://x/ok",
      cancelUrl: "https://x/no",
    });
    expect(provider.checkouts).toMatchObject([{ overagePriceRef: "price_overage" }]);
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

  it("records the seats a checkout asked for, and bills the change at the same count", async () => {
    const provider = new FakeProvider();
    await provider.createCheckout({
      subscriptionId: "sub_team",
      planKey: "pro",
      priceRef: "price_x",
      seats: 4,
      successUrl: "https://x/ok",
      cancelUrl: "https://x/no",
    });
    await provider.previewPlanChange({ providerRef: "sub_team", priceRef: "price_x", seats: 6 });
    await provider.changePlan({
      providerRef: "sub_team",
      priceRef: "price_x",
      planKey: "pro",
      seats: 6,
      prorationDate: new Date(),
    });

    expect(provider.checkouts).toMatchObject([{ seats: 4 }]);
    // The quote and the change have to name the same count, or the customer is
    // billed for a number of seats they were never shown a price for.
    expect(provider.previews).toMatchObject([{ seats: 6 }]);
    expect(provider.planChanges).toMatchObject([{ seats: 6 }]);
  });

  it("buys in the currency it was asked for, and quotes the change in that one", async () => {
    const provider = new FakeProvider();
    await provider.createCheckout({
      subscriptionId: "sub_vn",
      planKey: "pro",
      priceRef: "price_x",
      currency: "vnd",
      successUrl: "https://x/ok",
      cancelUrl: "https://x/no",
    });
    const preview = await provider.previewPlanChange({
      providerRef: "sub_vn",
      priceRef: "price_scale",
      currency: "vnd",
    });

    expect(provider.checkouts).toMatchObject([{ currency: "vnd" }]);
    // A gateway bills a subscription in the currency it was created with, so a
    // quote that came back in another one is an amount nobody could be charged.
    expect(preview.currency).toBe("vnd");
  });

  it("records the trial a checkout asked for", async () => {
    const provider = new FakeProvider();
    await provider.createCheckout({
      subscriptionId: "sub_trial",
      planKey: "pro",
      priceRef: "price_x",
      trialDays: 14,
      successUrl: "https://x/ok",
      cancelUrl: "https://x/no",
    });
    expect(provider.checkouts).toMatchObject([{ planKey: "pro", trialDays: 14 }]);
  });
});

describe("stripe subscription items", () => {
  const licensed = { id: "si_plan", price: { recurring: { usage_type: "licensed" } } };
  const metered = { id: "si_meter", price: { recurring: { usage_type: "metered" } } };

  // Both halves of this are silent when they are wrong: a plan change that
  // repriced the meter would bill the customer for a plan they never chose,
  // and a usage record against the licensed item is refused by Stripe. The
  // order the two items come back in is not promised, so neither can be found
  // by position.
  it("finds the plan and the meter whichever order they arrive in", () => {
    expect(licensedItemOf([metered, licensed])?.id).toBe("si_plan");
    expect(meteredItemOf([licensed, metered])?.id).toBe("si_meter");
  });

  it("finds the plan on a subscription bought before the add-on was sold", () => {
    expect(licensedItemOf([licensed])?.id).toBe("si_plan");
    // Undefined rather than a throw: the caller knows whether this
    // subscription is supposed to carry a meter, and `reportUsage` is the one
    // that refuses.
    expect(meteredItemOf([licensed])).toBeUndefined();
  });

  it("takes an item with no recurring price at all for the plan", () => {
    // A one-off line is not a meter, and guessing otherwise would report usage
    // against something that cannot carry it.
    expect(licensedItemOf([{ id: "si_once" }])?.id).toBe("si_once");
    expect(meteredItemOf([{ id: "si_once" }])).toBeUndefined();
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

  // The session takes no money when the plan it is for has a trial, so reading
  // it as an activation would spend the trial in the same millisecond it
  // started — and the customer's first invoice would then arrive as a renewal
  // of a month they were never charged for.
  it("starts a trial, not a subscription, when the checkout granted one", () => {
    const event = normalize(
      stripeEvent("checkout.session.completed", {
        id: "cs_trial",
        subscription: "sub_trial",
        customer: "cus_trial",
        metadata: { planKey: "pro", trialDays: "14" },
      }),
    );
    expect(event).toMatchObject({
      type: "subscription_trialing",
      checkoutRef: "cs_trial",
      providerRef: "sub_trial",
      customerRef: "cus_trial",
      planKey: "pro",
    });
  });

  it("treats a checkout with no trial on it as the activation it is", () => {
    const event = normalize(
      stripeEvent("checkout.session.completed", {
        id: "cs_paid",
        metadata: { planKey: "pro", trialDays: "0" },
      }),
    );
    expect(event.type).toBe("subscription_activated");
  });

  it("maps the trial-ending warning to its own type, and carries the refs", () => {
    // Its own type rather than `unknown`: the event log is read by people, and
    // "a trial is about to lapse" is worth finding there when the invoice that
    // follows it fails.
    expect(
      normalize(
        stripeEvent("customer.subscription.trial_will_end", {
          id: "sub_ending",
          customer: "cus_ending",
        }),
      ),
    ).toMatchObject({
      type: "trial_ending",
      providerRef: "sub_ending",
      customerRef: "cus_ending",
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

  // Seats reach us the way the plan does, off the metadata the invoice
  // snapshots — and not off the line items, because a proration invoice has
  // several lines in no promised order, so the quantity on the first of them
  // may be the one being credited rather than the one being charged.
  it("carries the seat count a paid invoice was billed for", () => {
    const event = normalize(
      stripeEvent("invoice.paid", {
        subscription: "sub_10",
        subscription_details: { metadata: { planKey: "scale", seats: "6" } },
      }),
    );
    expect(event.seats).toBe(6);
  });

  it("reports no seat count rather than a nonsense one when the metadata has none", () => {
    expect(
      normalize(
        stripeEvent("invoice.paid", {
          subscription: "sub_11",
          subscription_details: { metadata: { planKey: "pro" } },
        }),
      ).seats,
    ).toBeUndefined();
    expect(
      normalize(
        stripeEvent("invoice.paid", {
          subscription: "sub_12",
          subscription_details: { metadata: { seats: "lots" } },
        }),
      ).seats,
    ).toBeUndefined();
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
