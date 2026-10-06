/**
 * The invoices a customer can open, read live off the gateway.
 *
 * Nothing about this list is stored, so there is nothing to assert in the
 * database — which is precisely why it is worth driving through a browser. The
 * two claims that would be silent if they broke are both here: the draft the
 * gateway is still assembling never reaches the page, and the documents the
 * rows link to are the gateway's own rather than anything this app serves.
 */
import { db } from "@/lib/db";
import { expect, test } from "./fixtures";

/** What the in-memory gateway holds for every customer. See providers/fake.ts. */
const ISSUED = { number: "FAKE-0001", total: "$29.00" };
const DRAFT_TOTAL = "$99.00";

test("lists the issued invoices with the gateway's own documents", async ({
  page,
  workspace,
  clock,
}) => {
  await page.goto("/en/account");

  // No invoices before there is a customer to have been billed: the gateway
  // only tells us who the customer is on the first webhook.
  await expect(page.getByText("Nothing has been invoiced to this workspace yet.")).toBeVisible();

  const started = await page.request.post("/api/checkout", { data: { planKey: "pro" } });
  const { subscriptionId } = await started.json();
  const { checkoutRef } = await db.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
  });

  const providerRef = workspace.ref("sub");
  const customerRef = workspace.ref("cus");
  expect(
    await clock.send(
      clock.activation({
        checkoutRef: checkoutRef as string,
        providerRef,
        customerRef,
        planKey: "pro",
      }),
    ),
  ).toMatchObject({ outcome: "transitioned" });

  await page.reload();

  const paid = page.getByRole("row").filter({ hasText: ISSUED.number });
  await expect(paid).toContainText(ISSUED.total);
  await expect(paid).toContainText("Paid");

  // The document is the gateway's, and the link is rendered with the page
  // rather than minted on a click: unlike a portal session, a hosted invoice
  // lives on the invoice itself and is still the same document tomorrow.
  await expect(paid.getByRole("link", { name: "PDF" })).toHaveAttribute(
    "href",
    new RegExp(`^https://fake\\.invoice/.*${customerRef}.*\\.pdf$`),
  );

  // The row a past-due customer comes here for, under the status that says so.
  await expect(page.getByRole("row").filter({ hasText: "FAKE-0002" })).toContainText("Due");

  // And the draft the gateway is assembling for the month in progress, which
  // it hands back along with the rest: an amount nobody has been asked for,
  // with no document behind it, so it must not be on the page at all.
  await expect(page.getByText(DRAFT_TOTAL)).toHaveCount(0);
  await expect(page.getByText("Draft")).toHaveCount(0);

  // Cancelling does not take the history with it. A cancelled customer is
  // exactly who needs last month's invoice, which is why this list is read for
  // the workspace's newest customer whatever its subscription's status.
  expect(await clock.send(clock.cancellation({ providerRef }))).toMatchObject({
    outcome: "transitioned",
  });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Free" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: ISSUED.number })).toContainText(
    ISSUED.total,
  );
});
