/**
 * Writing down a role a workspace has handed out, and reading back the ones it
 * has.
 *
 * The write takes the client it is to use rather than reaching for `db`, so it
 * can go inside the transaction that moves the role itself. That is the whole
 * reason this is a module and not two queries at the call sites: a history
 * written in a transaction of its own could disagree with the column — a
 * crash in between would leave a role nobody granted, or a grant of a role
 * nobody holds — and the point of the table is to be the one place that
 * sequence survives.
 *
 * Unlike the replay audit, the row goes in *after* the work rather than before
 * it. A replay is claimed early because an attempt that dies halfway is itself
 * worth finding; a grant is not an attempt. What is wanted here is that every
 * role somebody holds was recorded as given to them, and the way to get that
 * is to write the row in the same transaction as the column, where neither can
 * land without the other.
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { roleFrom, type Role } from "@/domain/role";
import { ROLE_HISTORY_WINDOW, isGrant } from "@/domain/role-history";

/**
 * Just the one model this needs, so a caller may hand it a transaction client
 * or the client itself without this file caring which it was given.
 */
export type GrantWriter = Pick<Prisma.TransactionClient, "roleGrant">;

export interface GrantInput {
  tenantId: string;
  /** Who the role is for, with the address as it reads right now. */
  subject: { userId: string; email: string };
  /** Who gave it to them. Never defaulted: an unattributed grant is the one
   *  row this table exists to not have. */
  grantedBy: { userId: string; email: string };
  role: Role;
  /** What they held here before, or `null` for the first role they hold. */
  previousRole: Role | null;
}

/**
 * Record `input` as a grant, if it is one, and say whether it was.
 *
 * The decision is `isGrant`'s rather than this file's, so the write that
 * changes a role and the write that creates a membership cannot come to
 * different conclusions about what is worth recording.
 */
export async function recordRoleGrant(writer: GrantWriter, input: GrantInput): Promise<boolean> {
  if (!isGrant(input.previousRole, input.role)) return false;

  await writer.roleGrant.create({
    data: {
      tenantId: input.tenantId,
      subjectUserId: input.subject.userId,
      subjectEmail: input.subject.email,
      grantedByUserId: input.grantedBy.userId,
      grantedByEmail: input.grantedBy.email,
      role: input.role,
    },
  });
  return true;
}

/** One grant, as the transactions page lists it. */
export interface RoleGrantView {
  id: string;
  /** The addresses as they were at the time, which is what was recorded. */
  subjectEmail: string;
  grantedByEmail: string;
  role: Role;
  grantedAt: Date;
}

/**
 * The roles this workspace has handed out, newest first.
 *
 * Scoped to the tenant in SQL like every other list on that page. No cursor
 * behind it: `ROLE_HISTORY_WINDOW` says why the last few are the answer, and a
 * second paginated list would be a position to carry in the URL for the sake
 * of a question nobody asks twice.
 */
export async function roleHistoryOf(
  tenantId: string,
  limit = ROLE_HISTORY_WINDOW,
): Promise<RoleGrantView[]> {
  const rows = await db.roleGrant.findMany({
    where: { tenantId },
    orderBy: { grantedAt: "desc" },
    take: limit,
  });
  // Through `roleFrom` rather than cast, for the reason the roster does it: the
  // column is a string, and a value this build does not know reads as the role
  // that may change nothing.
  return rows.map((row) => ({
    id: row.id,
    subjectEmail: row.subjectEmail,
    grantedByEmail: row.grantedByEmail,
    role: roleFrom(row.role),
    grantedAt: row.grantedAt,
  }));
}
