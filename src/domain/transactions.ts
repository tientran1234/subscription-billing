/**
 * Paging and filtering the transaction lists. Pure — no I/O — like the rest of
 * this directory, so the rule that decides which row comes next is written once
 * and can be checked without a database.
 *
 * Keyset, not offset. `LIMIT n OFFSET n` counts rows from the start of the
 * result on every request, so a row inserted at the head between two requests
 * pushes that boundary along: the reader sees one row twice and never sees
 * another. Both lists here are read newest first and grow at the head — a
 * subscription attempt, a minted key — which is precisely the case offset gets
 * wrong. A cursor names the last row instead, and "everything older than this
 * row" does not depend on what arrived since.
 *
 * The cursor is (createdAt, id), never createdAt alone: two rows written in the
 * same millisecond would otherwise both sit exactly on the boundary, and
 * whichever way it is drawn one of them is dropped or repeated.
 */

import { Buffer } from "node:buffer";
import { isPlanKey, type PlanKey } from "./entitlements";
import { isSubscriptionStatus, type SubscriptionStatus } from "./subscription";

/** The ordering key. Every list here is ordered by it, descending. */
export interface Keyed {
  id: string;
  createdAt: Date;
}

export type Cursor = Keyed;

export interface Page<T> {
  items: T[];
  /** Null on the last page. */
  nextCursor: string | null;
}

export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;

/**
 * A page size out of a URL. Anything unusable falls back to the default rather
 * than refusing the request: how many rows to draw is a preference, and a
 * mistyped one should not stand between an admin and their own ledger. The cap
 * is not a preference — it is what stops `?limit=1000000` from being a query
 * that reads the whole table.
 */
export function parsePageSize(raw: string | null | undefined): number {
  const requested = Number(raw);
  if (!Number.isInteger(requested) || requested < 1) return PAGE_SIZE_DEFAULT;
  return Math.min(requested, PAGE_SIZE_MAX);
}

/**
 * Base64 is a discouragement from hand-editing, not a secret: a cursor only
 * ever names a row the caller can already see, and every query built from one
 * is still scoped to their own tenant, so a forged cursor buys nothing beyond
 * starting somewhere else in the caller's own list.
 */
export function encodeCursor(row: Keyed): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString("base64url");
}

/**
 * `null` for anything that is not a cursor we wrote. Callers treat that as a
 * bad URL rather than as "start from the beginning" — silently restarting the
 * list would look like the rows before the cursor had vanished.
 */
export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const separator = decoded.indexOf("|");
  if (separator < 1) return null;

  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
}

/**
 * Is `row` on the far side of the cursor, under "newest first, id breaking the
 * tie"? The query layer asks Postgres the same question in SQL; this is the
 * version the tests can run over rows they hold, which is how the two are
 * checked against each other rather than assumed to agree.
 */
export function isOlderThanCursor(row: Keyed, cursor: Cursor): boolean {
  const rowTime = row.createdAt.getTime();
  const cursorTime = cursor.createdAt.getTime();
  if (rowTime !== cursorTime) return rowTime < cursorTime;
  return row.id < cursor.id;
}

/**
 * Turn `limit + 1` fetched rows into a page of at most `limit`.
 *
 * The extra row is why there is no COUNT: a "next" link should appear when
 * there really is a next row, and counting the table to learn that gets slower
 * as the table grows and is out of date by the time it renders. The cursor
 * comes off the last row RETURNED, never off the extra one — pointing it at the
 * row being withheld would skip exactly that row on the next page.
 */
export function pageOf<T extends Keyed>(fetched: readonly T[], limit: number): Page<T> {
  const items = fetched.slice(0, limit);
  const more = fetched.length > limit && items.length > 0;
  return { items, nextCursor: more ? encodeCursor(items[items.length - 1]) : null };
}

export interface SubscriptionFilter {
  status?: SubscriptionStatus;
  planKey?: PlanKey;
}

/**
 * Filter values arrive as URL text, so each one may be anything at all. An
 * unrecognised value drops its filter instead of narrowing to nothing: an empty
 * page is how "this tenant has never subscribed" looks, and a typo must not be
 * able to say that. Dropping it is not silent either — the filter in force is
 * the one the page highlights, so a value that did not survive shows up as no
 * filter at all.
 */
export function parseSubscriptionFilter(raw: {
  status?: string | null;
  planKey?: string | null;
}): SubscriptionFilter {
  return {
    ...(isSubscriptionStatus(raw.status) ? { status: raw.status } : {}),
    ...(isPlanKey(raw.planKey) ? { planKey: raw.planKey } : {}),
  };
}

export const KEY_STATES = ["active", "revoked"] as const;
export type KeyState = (typeof KEY_STATES)[number];

/** Undefined means both — a revoked key's usage is still part of the month. */
export function parseKeyState(raw: string | null | undefined): KeyState | undefined {
  return (KEY_STATES as readonly string[]).includes(raw ?? "")
    ? (raw as KeyState)
    : undefined;
}

/**
 * Which UTC month of usage to read, as `meter` buckets it. The fallback is
 * passed in rather than read off the clock here so this stays pure; the caller
 * hands it the current period.
 */
export function parsePeriod(raw: string | null | undefined, fallback: string): string {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(raw ?? "") ? (raw as string) : fallback;
}
