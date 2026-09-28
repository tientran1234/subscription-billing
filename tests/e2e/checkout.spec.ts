/**
 * Checkout, through the browser, across a renewal.
 *
 * The renewal is why there is a clock at all: everything else about a
 * subscription can be provoked on demand, but the second period only arrives
 * a month later, and "entitlements survive it" is the claim nobody checks.
 */
import { db } from "@/lib/db";
import { PERIOD_DAYS } from "./clock";
import { expect, test } from "./fixtures";

test("a checkout becomes paid access, and keeps it a month later", async ({
  page,
  workspace,
  clock,
}) => {
  await page.goto("/en/account");
  await expect(page.getByRole("heading", { name: "Free" })).toBeVisible();

  const started = await page.request.post("/api/checkout", { data: { planKey: "pro" } });
  expect(started.status()).toBe(201);
  const { subscriptionId } = await started.json();

  // Started, not paid for. The gateway has not said anything yet, and the plan
  // on the page is derived from what it has said.
  const pending = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  expect(pending.status).toBe("PENDING");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Free" })).toBeVisible();

  const refs = {
    // The gateway's own reference, read back rather than guessed: the shape of
    // it belongs to the adapter, not to this test.
    checkoutRef: pending.checkoutRef as string,
    providerRef: workspace.ref("sub"),
    customerRef: workspace.ref("cus"),
    planKey: "pro",
  };
  expect(await clock.send(clock.activation(refs))).toMatchObject({
    status: 200,
    outcome: "transitioned",
  });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Pro" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "export" })).toBeVisible();

  // The first invoice buys the first period.
  expect(await clock.send(clock.paidInvoice({ providerRef: refs.providerRef }))).toMatchObject({
    outcome: "renewed",
  });
  const firstPeriod = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  expect(firstPeriod.currentPeriodEnd).toEqual(clock.periodEnd());

  // A month on. Without the clock this is the assertion that never runs.
  clock.advanceBy(PERIOD_DAYS);
  expect(await clock.send(clock.paidInvoice({ providerRef: refs.providerRef }))).toMatchObject({
    outcome: "renewed",
  });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Pro" })).toBeVisible();

  const renewed = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  expect(renewed.status).toBe("ACTIVE");
  // Moved, not re-set: a renewal that left the old date behind would read as
  // expired to anything that trusts it.
  expect(renewed.currentPeriodEnd).toEqual(clock.periodEnd());
  expect(renewed.currentPeriodEnd!.getTime()).toBeGreaterThan(
    firstPeriod.currentPeriodEnd!.getTime(),
  );
});
