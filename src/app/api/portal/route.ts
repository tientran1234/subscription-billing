import { z } from "zod";
import { StripeProvider } from "@/providers/stripe";
import { startPortalSession } from "@/server/billing.service";
import { withSession } from "@/server/with-session";
import { env } from "@/lib/env";

export const runtime = "nodejs";

// Nothing to send: the tenant comes from the session and the customer from
// that tenant's own rows. `.strict()` on an empty object so a caller passing
// `tenantId` or `customerRef` gets a 400 rather than a hint that either would
// ever have been read.
const Body = z.object({}).strict();

export const POST = withSession(async (request, { tenantId }) => {
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json(
      { error: "invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const e = env();
  const provider = new StripeProvider(e.STRIPE_SECRET_KEY, e.STRIPE_WEBHOOK_SECRET);
  const result = await startPortalSession(provider, { tenantId, appUrl: e.APP_URL });

  if (!result.ok) {
    // 409, not 404: the tenant is real and so is the endpoint — there is just
    // nothing to manage until they have subscribed once.
    return Response.json({ error: "no subscription to manage yet" }, { status: 409 });
  }

  // Not a redirect: the link is single-use and short-lived, so the caller
  // decides when to follow it rather than having a preflight burn it.
  return Response.json({ portalUrl: result.portalUrl }, { status: 201 });
});
