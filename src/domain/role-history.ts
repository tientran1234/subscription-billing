/**
 * What a workspace can say about the roles it has handed out: who holds one,
 * who gave it to them, and when.
 *
 * Pure — no I/O — like the rest of this directory, so the one rule that
 * decides whether a write is worth recording is written here instead of beside
 * each write that grants a role: the invite accepted into a workspace, and the
 * admin who changes somebody's role afterwards.
 *
 * Kept apart from `role.ts` because the two are read for opposite reasons.
 * `role.ts` decides what somebody may do, and every route that changes
 * anything runs it. Nothing here guards anything at all: a history is for the
 * workspace that wants to know how it came to be the way it is, and a rule in
 * this file must never become one a permission depends on — a check that read
 * the past rather than the column would be a second answer to who may act now,
 * and the one that goes stale the first time a row is missing.
 */

import type { Role } from "./role";

/**
 * How many grants the workspace is shown, newest first.
 *
 * A window and not a page back through them, for the reason the invoice list
 * keeps twelve: what this is read for is the last few changes — who made
 * somebody an admin, and when — and a workspace that has handed out more roles
 * than this has a table to query rather than a question the page can answer.
 */
export const ROLE_HISTORY_WINDOW = 20;

/**
 * Whether setting somebody's role to `role` grants anything, given the role
 * they held in this workspace before — `null` for somebody who held none.
 *
 * A write that leaves the role as it was is not a grant. Setting the role
 * somebody already has is deliberately allowed rather than refused — see
 * `checkRoleChange`, and the sole admin pressing "make admin" on their own row
 * that it exists for — so this path is handed no-ops in the ordinary course of
 * things. Recording them would not just pad the history: it would make the date
 * beside a role the date it was last confirmed instead of the date it was
 * given, which is the one thing the history is read for.
 */
export function isGrant(previous: Role | null, role: Role): boolean {
  return previous !== role;
}
