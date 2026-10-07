/**
 * A ceiling the customer sets, enforced on the way in.
 *
 * The add-on turns the quota into a threshold, so without a cap the only limit
 * on a month's invoice is how often the key is called. The cap is the limit, and
 * it is only worth anything if a request past it is refused where requests are
 * served — which is what this suite can see and a unit test cannot.
 *
 * The counter is seeded rather than driven to the quota two thousand calls at a
 * time: what is under test is the boundary, and `meter` counting to 2,000 is
 * already covered where counting is.
 */
import { db } from "@/lib/db";
import { PLANS } from "@/domain/entitlements";
import { OVERAGE_QUOTA } from "@/domain/overage";
import { currentPeriod } from "@/server/usage";
import { expect, test } from "./fixtures";

const QUOTA = PLANS.pro.quotas[OVERAGE_QUOTA];

test("a request past the workspace's own cap is refused, not billed", async ({
  page,
  request,
  workspace,
  clock,
}) => {
  // Pro with the add-on: the e2e environment carries an overage price, so
  // checkout buys the meter and the quota becomes a threshold.
  const started = await page.request.post("/api/checkout", { data: { planKey: "pro" } });
  const { subscriptionId } = await started.json();
  const { checkoutRef } = await db.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
  });

  expect(
    await clock.send(
      clock.activation({
        checkoutRef: checkoutRef as string,
        providerRef: workspace.ref("sub"),
        customerRef: workspace.ref("cus"),
        planKey: "pro",
      }),
    ),
  ).toMatchObject({ outcome: "transitioned" });

  // Sitting exactly on the allowance, so the next call is the first billable
  // one. Seeded, not spent — see the note at the top.
  await db.usageCounter.create({
    data: {
      tenantId: workspace.tenantId,
      feature: OVERAGE_QUOTA,
      period: currentPeriod(),
      used: QUOTA,
    },
  });

  // Set the cap the way a customer does, on the account page.
  await page.goto("/en/account");
  await expect(page.getByText("you are billed for whatever the month runs to")).toBeVisible();
  await page.getByLabel("Units past your quota").fill("1");
  await page.getByRole("button", { name: "Save cap" }).click();
  await expect(page.getByText("It applies from the next request.")).toBeVisible();
  // Read back from the row by the refreshed page, not from the field: a cap on
  // the screen that nothing has stored is the one thing this page must not say.
  await expect(page.getByText("Capped at 1 unit past your quota.")).toBeVisible();

  const minted = await page.request.post("/api/keys", { data: { scopes: ["assistant:use"] } });
  const { apiKey } = await minted.json();
  const callAssistant = () =>
    request.post("/api/assistant", {
      headers: { authorization: `Bearer ${apiKey}` },
      data: { prompt: "hello" },
    });

  // The first unit past the quota is inside the cap, so it is served and will be
  // billed — a cap is permission to spend up to it, not a refusal.
  const billable = await callAssistant();
  expect(billable.status()).toBe(200);
  expect(await billable.json()).toMatchObject({ overage: 1 });

  // The second is past it, and the workspace said not to.
  const refused = await callAssistant();
  expect(refused.status()).toBe(429);
  expect(await refused.json()).toMatchObject({ error: "spend cap reached", capUnits: 1 });

  // Lifting it serves the very next request: the cap is ours, so there is no
  // invoice to settle and nothing to wait for.
  await page.getByRole("button", { name: "Remove cap" }).click();
  await expect(page.getByText("you are billed for whatever the month runs to")).toBeVisible();
  expect((await callAssistant()).status()).toBe(200);
});

test("the cap is not offered where the quota is already a ceiling", async ({
  page,
  workspace,
}) => {
  // Free sells no add-on, so there is no bill to put a ceiling under and the
  // form would be a setting with no effect. Signed in all the same — a page
  // nobody is signed in to draws no form either, which would prove nothing.
  expect(workspace.tenantId).toBeTruthy();
  await page.goto("/en/account");
  await expect(page.getByRole("heading", { name: "Free" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Spend cap" })).toHaveCount(0);
});
