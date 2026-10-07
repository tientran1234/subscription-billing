/**
 * Reading and writing the ceiling a workspace set on its metered add-on.
 *
 * Two lines of Prisma, kept behind names rather than inlined, because the cap is
 * read by the route that refuses a call and by the job that bills the month, and
 * both have to get the same answer for a column nobody has written yet: a null
 * is `UNCAPPED`, not a zero.
 */
import { db } from "@/lib/db";
import { UNCAPPED, type SpendCap } from "@/domain/spend-cap";

export async function spendCapFor(tenantId: string): Promise<SpendCap> {
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { overageCap: true },
  });
  // A tenant that is not there answers the same as one that set nothing. The
  // callers have already proved the tenant is theirs, so this is the row having
  // been deleted underneath a request rather than a question about access.
  return tenant?.overageCap ?? UNCAPPED;
}

export async function setSpendCap(tenantId: string, cap: SpendCap): Promise<void> {
  await db.tenant.update({ where: { id: tenantId }, data: { overageCap: cap } });
}
