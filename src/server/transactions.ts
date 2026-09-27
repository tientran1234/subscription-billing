/**
 * The read side of the admin lists: two keyset-paginated queries.
 *
 * Both are scoped to one tenant inside the WHERE clause, so a page cannot show
 * someone else's ledger by forgetting to filter — the same reason revocation is
 * scoped by its UPDATE rather than by a read followed by a check. Nothing here
 * writes; the ordering rules all come from src/domain/transactions.ts.
 */
import { db } from "@/lib/db";
import { usageFeatureFor } from "@/domain/api-key";
import {
  PAGE_SIZE_DEFAULT,
  pageOf,
  type Cursor,
  type KeyState,
  type Page,
  type SubscriptionFilter,
} from "@/domain/transactions";
import { currentPeriod } from "./usage";

/**
 * The SQL half of `isOlderThanCursor`: strictly older, or the same instant and
 * a lower id. Written once, here, so both lists draw the boundary the same way.
 */
const olderThan = (cursor: Cursor) => ({
  OR: [
    { createdAt: { lt: cursor.createdAt } },
    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
  ],
});

/** Newest first. The id is not decoration — it is what makes the order total. */
const NEWEST_FIRST = [{ createdAt: "desc" }, { id: "desc" }] as const;

export interface ListInput {
  tenantId: string;
  cursor?: Cursor | null;
  limit?: number;
}

export interface SubscriptionRow {
  id: string;
  createdAt: Date;
  planKey: string;
  status: string;
  currentPeriodEnd: Date | null;
  /** Null until the first webhook for this attempt lands. */
  providerRef: string | null;
}

export async function listSubscriptions(
  input: ListInput & { filter?: SubscriptionFilter },
): Promise<Page<SubscriptionRow>> {
  const limit = input.limit ?? PAGE_SIZE_DEFAULT;
  const filter = input.filter ?? {};

  const rows = await db.subscription.findMany({
    where: {
      tenantId: input.tenantId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.planKey ? { planKey: filter.planKey } : {}),
      ...(input.cursor ? olderThan(input.cursor) : {}),
    },
    orderBy: [...NEWEST_FIRST],
    // One more than the page, so "is there a next page" is answered by the rows
    // themselves instead of by a COUNT over the whole table.
    take: limit + 1,
    select: {
      id: true,
      createdAt: true,
      planKey: true,
      status: true,
      currentPeriodEnd: true,
      providerRef: true,
    },
  });

  return pageOf(rows, limit);
}

export interface KeyUsageRow {
  id: string;
  createdAt: Date;
  prefix: string;
  scopes: string[];
  quotaLimit: number | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  /** Calls metered against this key in the period. */
  used: number;
}

/**
 * Keys with what each one spent in a month.
 *
 * The keys are paged first and their counters read afterwards, for the page's
 * keys only. Joining the other way round — counters, then the key each belongs
 * to — would drop every key that has not been called yet, and "no calls this
 * month" is the answer an admin is most often looking for. A key with no
 * counter row is therefore zero, not missing: `meter` creates the row on the
 * first call of a period, so its absence means the calls never came.
 */
export async function listKeyUsage(
  input: ListInput & { state?: KeyState; period?: string },
): Promise<Page<KeyUsageRow> & { period: string }> {
  const limit = input.limit ?? PAGE_SIZE_DEFAULT;
  const period = input.period ?? currentPeriod();

  const keys = await db.apiKey.findMany({
    where: {
      tenantId: input.tenantId,
      ...(input.state === "active" ? { revokedAt: null } : {}),
      ...(input.state === "revoked" ? { revokedAt: { not: null } } : {}),
      ...(input.cursor ? olderThan(input.cursor) : {}),
    },
    orderBy: [...NEWEST_FIRST],
    take: limit + 1,
    select: {
      id: true,
      createdAt: true,
      prefix: true,
      scopes: true,
      quotaLimit: true,
      revokedAt: true,
      lastUsedAt: true,
    },
  });

  const page = pageOf(keys, limit);

  // Counters are keyed by the feature name the meter writes, not by the key id,
  // so both sides go through usageFeatureFor and the list cannot end up
  // reporting a bucket nothing fills.
  const counters = await db.usageCounter.findMany({
    where: {
      tenantId: input.tenantId,
      period,
      feature: { in: page.items.map((key) => usageFeatureFor(key.id)) },
    },
    select: { feature: true, used: true },
  });
  const used = new Map(counters.map((counter) => [counter.feature, counter.used]));

  return {
    ...page,
    period,
    items: page.items.map((key) => ({ ...key, used: used.get(usageFeatureFor(key.id)) ?? 0 })),
  };
}
