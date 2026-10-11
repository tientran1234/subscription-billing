/**
 * A seat offered, refused, and given back.
 *
 * There is no mail server behind this suite — the workspace fixture explains
 * why, and the dunning notices get away with it because a notice swallows its
 * own failures. An invite does not: the row is a promise that somebody was
 * told, so a send that fails takes the row back, and that makes this the one
 * environment where the release is the thing on screen. So that is what is
 * driven here, along with the refusals that are decided before any mail is
 * composed.
 *
 * The accepted path — a seat held, then taken by the address it was offered to,
 * then the floor that will not sell it back — needs a mailer that works, and is
 * held to a real Postgres with one in tests/invites.integration.test.ts.
 *
 * Every count below is read back from the refreshed page rather than from the
 * field that was typed into: a seat the screen says is held but nothing has
 * stored is a figure a customer would reason about their next invoice with.
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { expect, test, type Workspace } from "./fixtures";

/**
 * Seats bought, so there is room to offer one. Carries the gateway-side ids a
 * reprice needs — the floor is only reachable on a subscription the gateway is
 * already billing.
 */
const sell = (workspace: Workspace, seats: number) =>
  db.subscription.create({
    data: {
      tenantId: workspace.tenantId,
      planKey: "pro",
      status: "ACTIVE",
      seats,
      providerRef: workspace.ref("sub"),
      customerRef: workspace.ref("cus"),
    },
  });

test("an invite that could not be sent is holding no seat", async ({ page, workspace }) => {
  await sell(workspace, 3);

  await page.goto("/en/account");
  await expect(page.getByText("1 of 3 seats taken.")).toBeVisible();

  await page.getByLabel("Email address").fill(`unreachable-${randomUUID()}@example.test`);
  await page.getByRole("button", { name: "Send invite" }).click();

  // Said in the reader's own language, off the reason the route sends back.
  await expect(page.getByText("no seat is being held")).toBeVisible();
  await expect(page.getByText("1 of 3 seats taken.")).toBeVisible();

  // The row went back with the failed send. A seat held for a fortnight on
  // behalf of somebody who never heard about it is a seat lost to nothing, and
  // the workspace would have no way to tell that from an invite being thought
  // over.
  expect(await db.invitation.count({ where: { tenantId: workspace.tenantId } })).toBe(0);

  // So the seat is still there to be sold back, which it would not be if the
  // refused invite were quietly holding it.
  const quoted = await page.request.post("/api/plan-change", {
    data: { planKey: "pro", seats: 1 },
  });
  expect(quoted.status()).toBe(200);
});

test("an address already in the workspace is told so, not told it is full", async ({
  page,
  workspace,
}) => {
  await sell(workspace, 3);

  await page.goto("/en/account");
  await page.getByLabel("Email address").fill(workspace.email);
  await page.getByRole("button", { name: "Send invite" }).click();

  // Decided before anything is composed, so this one is the rule talking and
  // not the missing mail server. Both are true of a full workspace being asked
  // to re-invite its own owner, and reporting the wrong one would send
  // somebody to buy a seat for a person who already has one.
  await expect(page.getByText("That address is already in this workspace.")).toBeVisible();
  await expect(page.getByText("1 of 3 seats taken.")).toBeVisible();
});

test("a member can be removed, and the last one cannot", async ({ page, workspace }) => {
  await sell(workspace, 3);

  // A second person in the workspace, written the way an accepted invite
  // leaves it. Getting there is the integration test's business; what this
  // needs is somebody to remove.
  const second = `member-${randomUUID()}@example.test`;
  const user = await db.user.create({ data: { email: second } });
  await db.membership.create({ data: { userId: user.id, tenantId: workspace.tenantId } });

  await page.goto("/en/account");
  await expect(page.getByText("2 of 3 seats taken.")).toBeVisible();

  await page
    .getByRole("row")
    .filter({ hasText: second })
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(page.getByText("1 of 3 seats taken.")).toBeVisible();
  await expect(page.getByText(second)).toHaveCount(0);

  // One member left, so no button is drawn: the only way to meet that refusal
  // is a request the page did not offer.
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
  const owner = await db.membership.findFirstOrThrow({ where: { tenantId: workspace.tenantId } });
  const refused = await page.request.delete(`/api/members/${owner.userId}`);
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ reason: "last_member" });
});

test("a workspace with every seat taken is not offered the form", async ({ page, workspace }) => {
  // One seat and the owner in it, so there is nothing to offer: the answer is a
  // sentence pointing at the seats above rather than a form that is refused.
  await page.goto("/en/account");
  await expect(page.getByText("1 of 1 seats taken.")).toBeVisible();
  await expect(page.getByText("Every seat is taken.")).toBeVisible();
  await expect(page.getByLabel("Email address")).toHaveCount(0);

  // The route refuses it too, for a caller that did not come through the page.
  const refused = await page.request.post("/api/invites", {
    data: { email: `nobody-${randomUUID()}@example.test` },
  });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ reason: "no_seat" });

  // Nothing was written, so no seat is held by an invite that was refused.
  expect(await db.invitation.count({ where: { tenantId: workspace.tenantId } })).toBe(0);
});
