/**
 * The line below its ceiling a workspace asks to be written to at: read it, or
 * move it.
 *
 * A session rather than an API key, like the spend cap next door: this is a
 * customer saying how much warning they want before their own cap starts
 * refusing calls, which is the account page's business. The tenant is the
 * session's own, as it is everywhere here.
 *
 * Its own route rather than a second field on the cap's, because the two are
 * set apart: a customer moves the ceiling when the month's budget changes and
 * the line when they learn how much notice they need, and a body carrying both
 * would make each save a statement about the other — the setting left out
 * being a caller who forgot rather than one who meant to leave it alone.
 *
 * Nothing is sent to the gateway, which has no idea either figure exists.
 */
import { z } from "zod";
import {
  MAX_CAP_WARNING_PCT,
  MIN_CAP_WARNING_PCT,
  capWarningPct,
  checkCapWarningAt,
} from "@/domain/cap-warning";
import { capSettingsFor, setCapWarningAt } from "@/server/spend-cap";
import { withSession } from "@/server/with-session";

export const runtime = "nodejs";

// `null` is a value a caller sends on purpose — it goes back to the default —
// so it is in the schema rather than left to an omitted field. The bounds are
// deliberately NOT repeated here: what a settable line is belongs to the domain
// rule, and a copy of it in a schema is the second answer that goes stale.
// `.strict()` for the usual reason — a body naming a tenant gets a 400, not a
// line moved on someone else's workspace.
const Body = z.object({ warnAtPct: z.number().nullable() }).strict();

// Both the raw answer and the line in force: a caller asking where they will be
// written to wants the figure that decides it, and `null` alone would make them
// re-implement the fallback to find out.
export const GET = withSession(async (_request, { tenantId }) => {
  const { warnAt } = await capSettingsFor(tenantId);
  return Response.json({ warnAtPct: warnAt, inForcePct: capWarningPct(warnAt) });
});

export const POST = withSession(async (request, { tenantId }) => {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { warnAtPct } = parsed.data;
  if (checkCapWarningAt(warnAtPct)) {
    return Response.json(
      {
        error:
          `the warning line must be a whole percent between ${MIN_CAP_WARNING_PCT} ` +
          `and ${MAX_CAP_WARNING_PCT}, or null for the default`,
      },
      { status: 400 },
    );
  }

  await setCapWarningAt(tenantId, warnAtPct);
  // 200 for the same reason the cap answers with one: the line is ours, so it
  // is in force for the very next request and there is nothing to wait for.
  return Response.json({ warnAtPct, inForcePct: capWarningPct(warnAtPct) });
}, { changesWorkspace: true });
