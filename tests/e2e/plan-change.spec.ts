/**
 * Changing plan from the account page.
 *
 * The route's two halves are unit-tested either side of this. What only exists
 * in the browser is the flow between them: that the customer is shown the
 * amount before anything is confirmed, and that confirming asks the gateway
 * rather than moving the plan here. The plan moves when the invoice for it is
 * paid, and not one moment earlier — which is the claim a customer notices,
 * because the alternative is paid-for access that a declined card never bought.
 *
 * Seats ride the same flow, and the picker is where the rule about them has to
 * hold in front of a customer: which plans may be moved to depends on the count
 * in the field, so a set of buttons rendered with the page would be the set for
 * the count they started with.
 */
import { db } from "@/lib/db";
import { FAKE_PRORATION_MINOR } from "@/providers/fake";
import { expect, test } from "./fixtures";

test("a quoted plan change lands only when its invoice is paid", async ({
  page,
  workspace,
  clock,
}) => {
  const started = await page.request.post("/api/checkout", {
    data: { planKey: "pro", seats: 3 },
  });
  const { subscriptionId } = await started.json();
  const { checkoutRef, seats } = await db.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
  });
  expect(seats).toBe(3);

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

  await page.goto("/en/account");
  await expect(page.getByRole("heading", { name: "Pro" })).toBeVisible();
  // The seats are part of what this workspace may do, derived like the plan.
  await expect(page.getByRole("listitem").filter({ hasText: "3 seats" })).toBeVisible();

  // Free is never offered: leaving a paid plan is a cancellation, and this app
  // does not end subscriptions. Nor is the plan the tenant is already on.
  await expect(page.getByRole("button", { name: "Switch to Free" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Switch to Pro" })).toHaveCount(0);

  // The plan already held becomes an offer the moment the seat count differs,
  // and stops being one again when it does not. Nothing was fetched to decide
  // that: it is the rule the route enforces, run over the number on screen.
  await expect(page.getByRole("button", { name: "Update seats" })).toHaveCount(0);
  await page.getByLabel("Seats").fill("4");
  await expect(page.getByRole("button", { name: "Update seats" })).toBeVisible();
  await page.getByLabel("Seats").fill("3");
  await expect(page.getByRole("button", { name: "Update seats" })).toHaveCount(0);

  const quoting = page.waitForResponse((r) => r.url().includes("/api/plan-change"));
  await page.getByRole("button", { name: "Switch to Scale" }).click();
  const quote = await (await quoting).json();

  // The amount is on the screen before there is anything to confirm.
  await expect(page.getByText(`$${(FAKE_PRORATION_MINOR / 100).toFixed(2)}`)).toBeVisible();

  const confirming = page.waitForResponse((r) => r.url().includes("/api/plan-change"));
  await page.getByRole("button", { name: "Confirm" }).click();
  const confirmed = await confirming;
  await expect(page.getByText(/Asked for/)).toBeVisible();

  // 202, and the quoted instant handed back exactly as it came: that is what
  // bills the figure the customer just read instead of one recomputed for
  // whenever they got round to clicking.
  expect(confirmed.status()).toBe(202);
  expect(JSON.parse(confirmed.request().postData() ?? "{}")).toEqual({
    planKey: "scale",
    // The seats that were quoted, carried across the plan move rather than
    // reset to one by it.
    seats: 3,
    prorationDate: quote.prorationDate,
  });

  // Asked for, and nothing else: no money has been taken, so the plan this app
  // serves has not moved — not in the database, and not on the page.
  await expect(
    db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } }),
  ).resolves.toMatchObject({ planKey: "pro" });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Pro" })).toBeVisible();

  // The proration invoice, paid. That is the evidence the plan moves on.
  expect(
    await clock.send(clock.paidInvoice({ providerRef, planKey: "scale", seats: 3 })),
  ).toMatchObject({ outcome: "repriced" });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Scale" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "3 seats" })).toBeVisible();
});
