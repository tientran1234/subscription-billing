/**
 * Stripe redelivers, on purpose. The unit tests pin that at the service; this
 * pins it at the edge the gateway actually posts to, where the raw bytes, the
 * signature check and the route's "always 200" all get a say.
 */
import { db } from "@/lib/db";
import { expect, test } from "./fixtures";

test("the same delivery twice activates once", async ({ page, workspace, clock }) => {
  await page.goto("/en/account");
  const started = await page.request.post("/api/checkout", { data: { planKey: "pro" } });
  const { subscriptionId } = await started.json();
  const { checkoutRef } = await db.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
  });

  const providerRef = workspace.ref("sub");
  const activation = clock.activation({
    checkoutRef: checkoutRef as string,
    providerRef,
    customerRef: workspace.ref("cus"),
    planKey: "pro",
  });

  expect(await clock.send(activation)).toMatchObject({ outcome: "transitioned" });

  // The very same bytes, signature and all — a redelivery, not a re-creation.
  // A non-2xx here would make Stripe keep sending something that can never
  // succeed, so the replay is a 200 that did nothing.
  expect(await clock.send(activation)).toMatchObject({ status: 200, outcome: "duplicate" });

  const after = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  expect(after.status).toBe("ACTIVE");
  expect(
    await db.webhookEvent.count({
      where: { providerEventId: { startsWith: clock.eventIdPrefix } },
    }),
  ).toBe(1);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Pro" })).toBeVisible();
});

test("a second activation under a fresh event id still cannot re-activate", async ({
  page,
  workspace,
  clock,
}) => {
  await page.goto("/en/account");
  const started = await page.request.post("/api/checkout", { data: { planKey: "pro" } });
  const { subscriptionId } = await started.json();
  const { checkoutRef } = await db.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
  });

  const refs = {
    checkoutRef: checkoutRef as string,
    providerRef: workspace.ref("sub"),
    customerRef: workspace.ref("cus"),
    planKey: "pro",
  };

  expect(await clock.send(clock.activation(refs))).toMatchObject({ outcome: "transitioned" });

  // Idempotency does not cover this one: it is a different event id, so the
  // primary key lets it through and the state machine is all that is left.
  // ACTIVE → ACTIVE is not a legal transition, which is what makes the second
  // delivery of an activation harmless even when it is not literally a replay.
  expect(await clock.send(clock.activation(refs))).toMatchObject({
    status: 200,
    outcome: "no_transition",
  });

  const after = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  expect(after.status).toBe("ACTIVE");
});
