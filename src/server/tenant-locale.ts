/**
 * Reading and writing the language a workspace is written to in.
 *
 * Two lines of Prisma behind names, for the reason the spend cap's are: the
 * column is read by the dunning hook, by the cap warning and by the account
 * page, and all three have to get the same answer for a row nobody has written
 * yet. What that answer means is `noticeLocaleFor`'s to decide, so the read
 * hands back the stored value as it stands — null and all — rather than
 * resolving it here and leaving the callers unable to tell a choice from a
 * default.
 */
import { db } from "@/lib/db";
import type { Locale } from "@/i18n";

/** What the workspace has recorded, or null if it has never said. */
export async function tenantLocale(tenantId: string): Promise<string | null> {
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { locale: true },
  });
  // A tenant that is not there answers the same as one that set nothing, as it
  // does for the cap: the callers have already proved the tenant is theirs, so
  // this is a row deleted underneath a request, not a question about access.
  return tenant?.locale ?? null;
}

/**
 * Record a language for the workspace.
 *
 * Takes a `Locale` rather than a nullable one: unlike a cap, there is no
 * meaningful way to unset this. Every mail goes out in some language, so
 * "none" would only mean "the default", which a workspace can say by choosing
 * it — and then the row says they chose it.
 */
export async function setTenantLocale(tenantId: string, locale: Locale): Promise<void> {
  await db.tenant.update({ where: { id: tenantId }, data: { locale } });
}
