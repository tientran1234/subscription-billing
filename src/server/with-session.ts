import type { Session } from "next-auth";
import { resolveTenant, type Principal } from "@/domain/membership";
import { canChangeWorkspace, type Role } from "@/domain/role";
import { auth } from "@/lib/auth";

/** Sign-in or ownership failure, carrying the status the route should return. */
export class SessionError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 409,
    /**
     * Which refusal it was, for the ones a page has a sentence of its own for.
     * Alongside the message rather than instead of it, as the invite and
     * removal refusals are: the status is shared and the reader's language is
     * the page's business.
     */
    readonly reason?: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

export interface SessionContext {
  userId: string;
  /** The signed-in address. Checkout bills this, never an address off the body. */
  email: string;
  tenantId: string;
  /** What this caller may do there, off the membership that matched. */
  role: Role;
}

/**
 * What a route needs beyond a session, declared where the handler is exported.
 *
 * Per export rather than per file, because a `GET` beside a `POST` is a read
 * and everybody in a workspace may read what they are being billed for.
 */
export interface RouteGuard {
  /**
   * This route changes the workspace, so only a role that may do that reaches
   * it. Named for what the route does rather than for who may call it: the
   * question "may a member do this" has one answer, and it is in
   * src/domain/role.ts rather than repeated at eleven call sites.
   */
  changesWorkspace?: boolean;
}

/**
 * A member of several tenants has to say which one, and there are two ways
 * they can have said it.
 *
 * The header is where a request names a tenant outright. A body field is still
 * not — it would look like an argument the handler acts on, which is the bug
 * this whole file exists to make impossible.
 *
 * The cookie is where a workspace chosen from a picker is remembered. It is
 * there because a page cannot set a header on its own navigation: without it a
 * choice made on one screen would be forgotten by the next link clicked, which
 * is why the picker could not be built before there was somewhere to keep its
 * answer. Neither is trusted — both only ever narrow the set of tenants the
 * session already grants, which is `resolveChosenTenant`'s guarantee and not
 * this file's.
 */
export const TENANT_HEADER = "x-tenant-id";
export const TENANT_COOKIE = "workspace";

/**
 * How long a browser keeps the workspace it was told to remember. Long,
 * because the alternative is a reader picking the same one every Monday.
 */
const TENANT_COOKIE_DAYS = 180;

/**
 * The `Set-Cookie` for a workspace a picker has just settled on.
 *
 * `HttpOnly` because nothing in the browser reads it: the pages are rendered
 * from it on the server, and `fetch` sends it back without being asked.
 *
 * `SameSite=Lax` is the load-bearing one. A cross-site POST carries no cookie
 * under it, so an account in several workspaces meets the same 409 on a
 * request it did not make itself that it met before there was anything to
 * remember — the choice cannot become a way for another site to pick which of
 * somebody's workspaces its forged request lands on.
 */
export function chosenWorkspaceCookie(tenantId: string): string {
  const attributes = [
    `${TENANT_COOKIE}=${encodeURIComponent(tenantId)}`,
    "Path=/",
    "SameSite=Lax",
    "HttpOnly",
    `Max-Age=${TENANT_COOKIE_DAYS * 86_400}`,
  ];
  // Over http in development, where there is no TLS to require.
  if (process.env.NODE_ENV === "production") attributes.push("Secure");
  return attributes.join("; ");
}

export function principalFrom(session: Session | null): Principal | null {
  const userId = session?.user?.id;
  if (!userId) return null;
  return { userId, memberships: session.memberships ?? [] };
}

/**
 * Session (plus, at most, a tenant header) → the tenant this request acts on.
 * Throws rather than returns a union: every caller's failure path is the same
 * JSON error, and a forgotten branch should not be able to fall through into
 * the handler.
 */
export function sessionContextFrom(
  session: Session | null,
  request: Request,
  guard: RouteGuard = {},
): SessionContext {
  const principal = principalFrom(session);
  if (!principal || !session?.user?.email) throw new SessionError("sign in first", 401);

  const resolved = resolveTenant(principal, request.headers.get(TENANT_HEADER));
  if (!resolved.ok) {
    if (resolved.reason === "ambiguous") {
      throw new SessionError(`several tenants — pick one with ${TENANT_HEADER}`, 409);
    }
    // "forbidden" and "no_tenant" share a response for the same reason the
    // domain rule shares them: the caller learns nothing about what exists.
    throw new SessionError("no access to that tenant", 403);
  }

  // After the tenant and not before it: what somebody may do is a question
  // about a workspace, so there is nothing to refuse them until it is settled
  // which one they are acting for. It also keeps the two 403s apart — a caller
  // outside the workspace learns nothing about it, and a member inside it is
  // told plainly that this takes an admin.
  if (guard.changesWorkspace && !canChangeWorkspace(resolved.role)) {
    throw new SessionError(
      "only this workspace's admins may change it",
      403,
      "not_an_admin",
    );
  }

  return {
    userId: principal.userId,
    email: session.user.email,
    tenantId: resolved.tenantId,
    role: resolved.role,
  };
}

/**
 * Wrap a route handler: require a session, resolve the tenant, check the role
 * against what the route does, then run. The handler receives the tenant id
 * and has no reason to read one from the body — the counterpart of withApiKey
 * for human callers.
 *
 * A route that changes something says so in `guard`, and a route that forgets
 * to is a read. That is the right way round for a default: the gate is one
 * word at the export, visible beside the verb, where a reviewer looking at a
 * `POST` can see whether it has one.
 */
export function withSession<Args extends unknown[]>(
  handler: (request: Request, ctx: SessionContext, ...args: Args) => Promise<Response>,
  guard: RouteGuard = {},
): (request: Request, ...args: Args) => Promise<Response> {
  return async (request, ...args) => {
    let ctx: SessionContext;
    try {
      ctx = sessionContextFrom(await auth(), request, guard);
    } catch (err) {
      if (err instanceof SessionError) {
        return Response.json(
          err.reason ? { error: err.message, reason: err.reason } : { error: err.message },
          { status: err.status },
        );
      }
      throw err;
    }
    return handler(request, ctx, ...args);
  };
}
