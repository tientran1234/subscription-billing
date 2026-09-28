/**
 * Access ends with the subscription that paid for it.
 *
 * Nothing runs in between the cancellation and the next request: no job, no
 * cache to invalidate, no copy of the plan on the tenant row. That is the whole
 * point of deriving entitlements on the read, and it is only visible from
 * outside — which is what this suite is for.
 */
import { db } from "@/lib/db";
import { expect, test } from "./fixtures";

const PRO_QUOTA = 2_000;
const FREE_QUOTA = 50;

test("cancelling drops the workspace to Free on the very next request", async ({
  page,
  request,
  workspace,
  clock,
}) => {
  await page.goto("/en/account");
  const started = await page.request.post("/api/checkout", { data: { planKey: "pro" } });
  const { subscriptionId } = await started.json();
  const { checkoutRef } = await db.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
  });

  const providerRef = workspace.ref("sub");
  expect(
    await clock.send(
      clock.activation({
        checkoutRef: checkoutRef as string,
        providerRef,
        customerRef: workspace.ref("cus"),
        planKey: "pro",
      }),
    ),
  ).toMatchObject({ outcome: "transitioned" });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Pro" })).toBeVisible();

  // A machine caller carrying nothing but its key: no session, no tenant on the
  // body, so what it may do comes entirely from the subscription behind it.
  const minted = await page.request.post("/api/keys", { data: { scopes: ["assistant:use"] } });
  expect(minted.status()).toBe(201);
  const { apiKey } = await minted.json();
  const callAssistant = () =>
    request.post("/api/assistant", {
      headers: { authorization: `Bearer ${apiKey}` },
      data: { prompt: "hello" },
    });

  const paid = await callAssistant();
  expect(paid.status()).toBe(200);
  expect(await paid.json()).toMatchObject({ planKey: "pro", quota: { limit: PRO_QUOTA } });

  // Cancelled at the gateway, because this app never writes that itself.
  expect(await clock.send(clock.cancellation({ providerRef }))).toMatchObject({
    outcome: "transitioned",
  });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Free" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "export" })).toHaveCount(0);

  // The same key, unrevoked and still valid — it is the plan behind it that is
  // gone, and the quota it is metered against moves with it.
  const dropped = await callAssistant();
  expect(dropped.status()).toBe(200);
  expect(await dropped.json()).toMatchObject({ planKey: "free", quota: { limit: FREE_QUOTA } });
});
