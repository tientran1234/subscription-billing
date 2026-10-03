import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";
import { PLANS } from "@/domain/entitlements";
import { resolveTenant } from "@/domain/membership";
import { SUBSCRIPTION_STATUSES } from "@/domain/subscription";
import {
  KEY_STATES,
  decodeCursor,
  parseKeyState,
  parsePageSize,
  parsePeriod,
  parseSubscriptionFilter,
  shiftPeriod,
  type Cursor,
} from "@/domain/transactions";
import { auth } from "@/lib/auth";
import { listKeyUsage, listSubscriptions } from "@/server/transactions";
import { currentPeriod } from "@/server/usage";
import { principalFrom, TENANT_HEADER } from "@/server/with-session";
import { ReplayForm } from "./replay-form";

/** Server-rendered dates, so there is no locale to disagree with the client. */
const day = (date: Date) => date.toISOString().slice(0, 10);

/**
 * A cursor that is present but unreadable is a broken link, not page one.
 * Quietly restarting the list would look like every row before the cursor had
 * been deleted, which on a billing ledger is the worst way to be wrong.
 */
function cursorFrom(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  const cursor = decodeCursor(raw);
  if (!cursor) notFound();
  return cursor;
}

/**
 * This page with some parameters replaced. Changing a filter drops that list's
 * cursor: a cursor is a position in one particular sequence, so carrying it into
 * a differently filtered list would open the new list halfway down.
 */
function href(
  locale: string,
  current: URLSearchParams,
  changes: Record<string, string | null>,
): string {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  const query = next.toString();
  return `/${locale}/admin${query ? `?${query}` : ""}`;
}

/** One row of filter pills. `null` is the value that clears the filter. */
function Filters({
  options,
  active,
  build,
}: {
  options: readonly { value: string | null; label: string }[];
  active: string | null;
  build: (value: string | null) => string;
}) {
  return (
    <p className="filters">
      {options.map((option) => (
        <Link
          key={option.value ?? "all"}
          href={build(option.value)}
          aria-current={option.value === active ? "true" : undefined}
        >
          {option.label}
        </Link>
      ))}
    </p>
  );
}

export default async function AdminPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const t = await getTranslations("admin");

  const principal = principalFrom(await auth());
  if (!principal) {
    return (
      <main>
        <h1>{t("title")}</h1>
        <p className="sub">{t("signedOut")}</p>
        <Link href="/api/auth/signin">{t("signIn")}</Link>
      </main>
    );
  }

  // The same rule every route runs, from the same pure function. There are no
  // roles here, so "admin" means the workspace this account already belongs to:
  // the lists below are scoped to that tenant in SQL, not by this page.
  const resolved = resolveTenant(principal, (await headers()).get(TENANT_HEADER));
  if (!resolved.ok) {
    return (
      <main>
        <h1>{t("title")}</h1>
        <p className="sub">{resolved.reason === "ambiguous" ? t("ambiguous") : t("noTenant")}</p>
        <Link href={`/${locale}/account`}>{t("backToAccount")}</Link>
      </main>
    );
  }
  const tenantId = resolved.tenantId;

  const raw = await searchParams;
  const first = (key: string) => {
    const value = raw[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const current = new URLSearchParams(
    Object.keys(raw).flatMap((key) => {
      const value = first(key);
      return value ? [[key, value] as [string, string]] : [];
    }),
  );

  const limit = parsePageSize(first("limit"));
  const filter = parseSubscriptionFilter({ status: first("status"), planKey: first("plan") });
  const state = parseKeyState(first("state"));
  const period = parsePeriod(first("period"), currentPeriod());

  const [subscriptions, keys] = await Promise.all([
    listSubscriptions({ tenantId, filter, cursor: cursorFrom(first("subAfter")), limit }),
    listKeyUsage({ tenantId, state, period, cursor: cursorFrom(first("keyAfter")), limit }),
  ]);

  return (
    <main>
      <h1>{t("title")}</h1>
      <p className="sub">{t("subtitle")}</p>

      <section className="list">
        <h2>{t("subscriptions")}</h2>
        <Filters
          options={[
            { value: null, label: t("all") },
            ...SUBSCRIPTION_STATUSES.map((status) => ({ value: status, label: status })),
          ]}
          active={filter.status ?? null}
          build={(value) => href(locale, current, { status: value, subAfter: null })}
        />
        <Filters
          options={[
            { value: null, label: t("allPlans") },
            ...Object.entries(PLANS).map(([key, plan]) => ({ value: key, label: plan.name })),
          ]}
          active={filter.planKey ?? null}
          build={(value) => href(locale, current, { plan: value, subAfter: null })}
        />

        {subscriptions.items.length === 0 ? (
          <p className="sub">{t("noSubscriptions")}</p>
        ) : (
          <table className="rows">
            <thead>
              <tr>
                <th>{t("created")}</th>
                <th>{t("plan")}</th>
                <th>{t("status")}</th>
                <th>{t("periodEnd")}</th>
                <th>{t("reference")}</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.items.map((row) => (
                <tr key={row.id}>
                  <td>{day(row.createdAt)}</td>
                  <td>{row.planKey}</td>
                  <td>{row.status}</td>
                  <td>{row.currentPeriodEnd ? day(row.currentPeriodEnd) : t("unknown")}</td>
                  {/* Null until the first webhook for this attempt arrives. */}
                  <td>{row.providerRef ?? t("unknown")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {subscriptions.nextCursor ? (
          <Link href={href(locale, current, { subAfter: subscriptions.nextCursor })}>
            {t("next")}
          </Link>
        ) : null}
      </section>

      <section className="list">
        <h2>{t("keys")}</h2>
        <Filters
          options={[
            { value: null, label: t("all") },
            ...KEY_STATES.map((value) => ({ value, label: t(value) })),
          ]}
          active={state ?? null}
          build={(value) => href(locale, current, { state: value, keyAfter: null })}
        />
        <p className="filters">
          <Link href={href(locale, current, { period: shiftPeriod(period, -1), keyAfter: null })}>
            {t("earlierMonth")}
          </Link>
          <Link href={href(locale, current, { period: shiftPeriod(period, 1), keyAfter: null })}>
            {t("laterMonth")}
          </Link>
        </p>

        {keys.items.length === 0 ? (
          <p className="sub">{t("noKeys")}</p>
        ) : (
          <table className="rows">
            <thead>
              <tr>
                <th>{t("created")}</th>
                <th>{t("prefix")}</th>
                <th>{t("scopes")}</th>
                <th>{t("status")}</th>
                <th className="num">{t("calls", { period: keys.period })}</th>
                <th className="num">{t("quota")}</th>
              </tr>
            </thead>
            <tbody>
              {keys.items.map((row) => (
                <tr key={row.id}>
                  <td>{day(row.createdAt)}</td>
                  <td>{row.prefix}</td>
                  <td>{row.scopes.join(" ")}</td>
                  <td>{row.revokedAt ? `${t("revoked")} ${day(row.revokedAt)}` : t("active")}</td>
                  {/* Zero, not blank: a key with no counter row was never called. */}
                  <td className="num">{row.used}</td>
                  <td className="num">{row.quotaLimit ?? t("unmetered")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {keys.nextCursor ? (
          <Link href={href(locale, current, { keyAfter: keys.nextCursor })}>{t("next")}</Link>
        ) : null}
      </section>

      <ReplayForm
        labels={{
          heading: t("replay"),
          note: t("replayNote"),
          eventId: t("replayEventId"),
          action: t("replayAction"),
          sending: t("replaySending"),
          done: t("replayDone"),
          refused: t("replayRefused"),
          failed: t("replayFailed"),
        }}
      />

      <p className="sub" style={{ marginTop: 40 }}>
        {t("scopeNote")}
      </p>
      <Link href={`/${locale}/account`}>{t("backToAccount")}</Link>
    </main>
  );
}
