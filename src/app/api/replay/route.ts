import { z } from "zod";
import { billingProvider } from "@/providers";
import { replayEvent } from "@/server/replay";
import { withSession } from "@/server/with-session";
import { env } from "@/lib/env";

export const runtime = "nodejs";

// The event id and nothing else. `.strict()`, so a caller sending a payload of
// their own — or a `tenantId` — gets a 400 rather than having either read:
// what is applied is the gateway's copy of the event, fetched server-side, and
// the tenant is the session's.
const Body = z.object({ providerEventId: z.string().min(1) }).strict();

export const POST = withSession(async (request, { tenantId, userId, email }) => {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const e = env();
  const result = await replayEvent(billingProvider(), {
    providerEventId: parsed.data.providerEventId,
    tenantId,
    userId,
    userEmail: email,
    appUrl: e.APP_URL,
  });

  // One answer for all three refusals, for the reason `resolveTenant` shares
  // one: an id the gateway has nothing under, an id that matches no
  // subscription and an id belonging to another workspace have to be
  // indistinguishable here, or this endpoint becomes a way to ask which event
  // ids are real in somebody else's ledger. The audit row keeps the three
  // apart, where only this workspace's own people can read them.
  if (!result.ok) {
    return Response.json({ error: "no such event for this workspace" }, { status: 404 });
  }

  // 200 with the outcome, whatever it is: `duplicate` means the delivery was
  // not missed after all and `no_transition` that it arrived too late to
  // matter, and both are the replay working rather than failing.
  return Response.json({ outcome: result.outcome, notified: result.notified });
});
