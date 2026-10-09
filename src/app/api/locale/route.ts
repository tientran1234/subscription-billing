/**
 * The language a workspace is written to in: read it, or change it.
 *
 * A session rather than an API key, like the spend cap next door: this is a
 * customer saying which language to address them in, which is the account
 * page's business. The tenant is the session's own, as it is everywhere here.
 *
 * What the column decides is the mail this application composes — the dunning
 * notice and the cap warning. The gateway composes its own as well, from the
 * language on its own customer record, so the choice is written across to it
 * too and a workspace stops being addressed in two languages at once.
 *
 * That write is best-effort by design, and the order says why: the column is
 * ours to guarantee, the gateway's copy is ours to ask for. A 200 here means
 * the choice is recorded and in force for the next notice we compose; whether
 * the gateway took it is reported beside that rather than instead of it.
 */
import { z } from "zod";
import { noticeLocaleFor } from "@/domain/notice-locale";
import { isLocale, locales } from "@/i18n";
import { syncNoticeLocale } from "@/server/billing.service";
import { billingProvider } from "@/providers";
import { setTenantLocale, tenantLocale } from "@/server/tenant-locale";
import { withSession } from "@/server/with-session";

export const runtime = "nodejs";

// Which strings are locales is deliberately NOT repeated here: the list lives
// in src/i18n.ts, and a copy of it in a schema is the second answer that goes
// stale the day one is added. `.strict()` for the usual reason — a body naming
// a tenant gets a 400, not a language set on someone else's workspace.
const Body = z.object({ locale: z.string() }).strict();

// The resolved language, not the raw column: a caller asking what we write to
// them in wants the answer we would actually send in, and `null` would make
// them re-implement the fallback to find out.
export const GET = withSession(async (_request, { tenantId }) =>
  Response.json({ locale: noticeLocaleFor(await tenantLocale(tenantId)) }),
);

export const POST = withSession(async (request, { tenantId }) => {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { locale } = parsed.data;
  if (!isLocale(locale)) {
    return Response.json(
      { error: `the locale must be one of: ${locales.join(", ")}` },
      { status: 400 },
    );
  }

  await setTenantLocale(tenantId, locale);
  // In force for the next notice composed, which is all there is to wait for.
  // The gateway is told after the column is written, so a gateway that is down
  // cannot cost the customer the choice they just made.
  const gateway = await syncNoticeLocale(billingProvider(), { tenantId, locale });
  return Response.json({ locale, gateway });
});
