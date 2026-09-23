import type { Session } from "next-auth";
import { resolveTenant, type Principal } from "@/domain/membership";
import { auth } from "@/lib/auth";

/** Sign-in or ownership failure, carrying the status the route should return. */
export class SessionError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 409,
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
}

/**
 * A member of several tenants has to say which one. The header is the only
 * place a request may name a tenant — a body field would look like an
 * argument the handler acts on, which is the bug this whole file exists to
 * make impossible.
 */
export const TENANT_HEADER = "x-tenant-id";

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
export function sessionContextFrom(session: Session | null, request: Request): SessionContext {
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

  return { userId: principal.userId, email: session.user.email, tenantId: resolved.tenantId };
}

/**
 * Wrap a route handler: require a session, resolve the tenant, then run. The
 * handler receives the tenant id and has no reason to read one from the body —
 * the counterpart of withApiKey for human callers.
 */
export function withSession<Args extends unknown[]>(
  handler: (request: Request, ctx: SessionContext, ...args: Args) => Promise<Response>,
): (request: Request, ...args: Args) => Promise<Response> {
  return async (request, ...args) => {
    let ctx: SessionContext;
    try {
      ctx = sessionContextFrom(await auth(), request);
    } catch (err) {
      if (err instanceof SessionError) {
        return Response.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
    return handler(request, ctx, ...args);
  };
}
