/**
 * Taking somebody out of a workspace, and setting what they may do in it.
 *
 * Its own route rather than a verb on the invites one: an invite is an offer
 * that can be withdrawn, and a membership is a person who has access right
 * now. They are released the same seat and nothing else in common.
 *
 * The removal is the one write here that is not simply `changesWorkspace`, and
 * `canRemoveMember` says why: leaving is not an administrative act, so a
 * member may take themselves out while only an admin may take anybody else.
 * The role check is therefore inside the handler, where the subject of the
 * request is known — the wrapper only ever sees who is asking.
 */
import { z } from "zod";
import type { RemovalRefusal } from "@/domain/invite";
import { canRemoveMember, roleFrom, ROLES, type RoleChangeRefusal } from "@/domain/role";
import { removeMember, setMemberRole } from "@/server/invites";
import { withSession } from "@/server/with-session";

export const runtime = "nodejs";

const REFUSALS: Record<RemovalRefusal | RoleChangeRefusal, { status: number; error: string }> = {
  // 404 rather than 403, as everywhere else here: somebody who is not in this
  // workspace is not an id the caller gets to confirm exists.
  not_a_member: { status: 404, error: "no such member" },
  last_member: {
    status: 409,
    error: "the last member cannot be removed — the subscription would be unreachable",
  },
  last_admin: {
    status: 409,
    error: "the last admin cannot be removed or demoted — nobody could change the workspace",
  },
};

// `.strict()` for the usual reason, and the role is checked against the domain
// rather than enumerated here a second time: `roleFrom` narrows anything it
// does not recognise to `member`, so the schema's job is only to insist that
// the caller said something.
const Body = z.object({ role: z.enum(ROLES) }).strict();

/** Change somebody's role. */
export const PATCH = withSession(
  async (request, { tenantId, userId: actorId, email }, ctx: { params: Promise<{ userId: string }> }) => {
    const { userId } = await ctx.params;
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json(
        { error: "invalid body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    // Who is granting it, off the session rather than the body — the same
    // place the tenant comes from, and for the same reason: an audit row whose
    // actor the caller could name would be worth nothing.
    const result = await setMemberRole(tenantId, userId, roleFrom(parsed.data.role), {
      userId: actorId,
      email,
    });
    if (!result.ok) {
      const refusal = REFUSALS[result.reason];
      return Response.json(
        { error: refusal.error, reason: result.reason },
        { status: refusal.status },
      );
    }
    // The session reads its memberships on every request, so the new role is
    // in force on the person's next one — the same promise removing them is.
    return new Response(null, { status: 204 });
  },
  { changesWorkspace: true },
);

export const DELETE = withSession(
  async (_request, { tenantId, userId: actorId, role }, ctx: { params: Promise<{ userId: string }> }) => {
    const { userId } = await ctx.params;

    // Before the removal rule, not after: whether the workspace survives
    // losing this person is a different question from whether this caller may
    // ask, and a member told `last_member` about somebody else's row would
    // have learned something about a workspace they may not administer.
    if (!canRemoveMember({ userId: actorId, role }, userId)) {
      return Response.json(
        { error: "only this workspace's admins may remove anybody else", reason: "not_an_admin" },
        { status: 403 },
      );
    }

    const result = await removeMember(tenantId, userId);
    if (!result.ok) {
      const refusal = REFUSALS[result.reason];
      // The reason alongside the sentence, as the invite route does it: the
      // page says which refusal it was in the reader's own language.
      return Response.json(
        { error: refusal.error, reason: result.reason },
        { status: refusal.status },
      );
    }
    // The membership was the access: entitlements are derived on read and the
    // session is a row in Postgres, so the person is out on their very next
    // request rather than when a token would have expired.
    return new Response(null, { status: 204 });
  },
);
