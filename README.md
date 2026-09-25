# subscription-billing

A small SaaS billing slice, built to be correct where billing usually goes wrong:
duplicate webhooks, webhooks that arrive out of order, and access that outlives
the subscription that paid for it.

Stripe subscription checkout → signed webhook → idempotent event log →
forward-only state machine → entitlements derived on read. Next.js App Router,
Postgres via Prisma, English and Vietnamese.

## Why it exists

Most billing bugs are not payment bugs. They are concurrency and
source-of-truth bugs:

- Stripe delivers the same event more than once, on purpose. Processing it twice
  double-activates, double-credits, or double-emails.
- Events do not arrive in the order they happened. A cancellation can land
  before the activation it followed.
- Entitlements copied onto a user row go stale the moment one webhook is missed,
  and a cancelled customer keeps paid features until a human notices.

Each of those has a specific answer below, and a test that fails if the answer
is removed.

## Design decisions

**The provider is an adapter, not the architecture.**
`src/domain/billing-event.ts` defines `IBillingProvider` and neutral DTOs.
`src/providers/stripe.ts` is the only file allowed to import `stripe`. Business
logic switches on our own event types, never on Stripe's. Adding Paddle or PayOS
means writing one adapter and changing nothing else — and
`tests/provider-conformance.test.ts` runs the same contract against every
provider, so that claim is checked rather than asserted.

**Idempotency is a primary key, not an `if`.**
`applyEvent` inserts the provider's event id into `WebhookEvent` before doing any
work. A replay loses on the primary key and returns `duplicate`. No read-then-act
window for a second delivery to slip through.

**Status transitions are enforced by Postgres, not by Node.**
`src/domain/subscription.ts` declares the legal transitions; the update runs as
`UPDATE ... WHERE id = ? AND status IN (legal predecessors)` and the affected-row
count says whether we won. Two deliveries racing produce one winner and one
no-op. `ACTIVE → ACTIVE` is not legal, which is what makes a replayed activation
harmless at the database level too.

**Entitlements are derived, never stored.**
`entitlementsFor(planKey, status)` is a pure function of the subscription. There
is no second copy to go stale, so a cancelled tenant drops to Free on the very
next request. `PAST_DUE` deliberately keeps paid access: a failed renewal is a
dunning problem, not a reason to lock someone out mid-month.

**The webhook route reads raw bytes.**
`await request.text()`, never `request.json()`. Stripe signs the exact bytes it
sent; re-serializing them breaks every signature.

**Once the signature verifies, the route answers 200.**
Every outcome — duplicate, ignored, out of order — is final. A non-2xx would make
Stripe retry something that will never succeed.

**Usage is incremented in the database.**
`UPDATE ... SET used = used + 1 RETURNING used`, so two concurrent requests
cannot both read 49 and both write 50.

**Cancelling happens at Stripe, not here.**
The account page hands the customer a link into Stripe's billing portal, where
they cancel, resume or update a card; the change comes back as a webhook like
any other. An in-app cancel would be a second writer of `status`, racing the
webhook reporting the very same change — and nothing sensible happens when the
two disagree. So `IBillingProvider` has no method that cancels or resumes one,
and the conformance suite pins each adapter's method surface so one cannot be
added by accident. The portal link is minted per click, because Stripe's is
single-use and expires in minutes. The customer id it opens for is resolved
from the caller's own tenant, never read off the request.

**Changing plan moves a price, not a status.**
Upgrading mid-cycle does go through the app, because it is not the thing
cancelling is. `/api/plan-change` quotes the proration with
`invoices.retrieveUpcoming` and charges nothing; confirming sends back the
instant that quote was computed at, so Stripe bills the amount the customer was
shown rather than what it would work out whenever they got round to clicking,
and a quote too old for that is refused instead of silently repriced. Confirming
writes nothing here: Stripe stores the new plan on the subscription and
snapshots it onto the proration invoice, and `planKey` moves when that invoice is
paid. A card that declines therefore leaves the tenant on the plan they are
still paying for, and a renewal raised before the upgrade but delivered after it
cannot put them back on the plan they left — it is older than the period already
stored, so it moves the dates and nothing else.

**People sign in; machines carry keys.**
A person gets a magic link — Auth.js, sessions in Postgres, no password to
leak. `withSession` resolves the tenant out of the session's membership rows,
`withApiKey` out of the key; neither reads a `tenantId` off the body, and both
bodies are `.strict()`, so a client still sending one gets a 400 rather than
quietly acting on someone else's tenant. A user who belongs to several tenants
names one in `x-tenant-id`, which can only narrow what their session already
grants. Revocation is scoped by the `UPDATE` itself, so the affected-row count
is the ownership check and there is no read-then-write window.

**API keys are hashed, scoped and metered.**
A key is `sk_<env>_<48 hex>`; only its SHA-256 is stored, the raw value is
returned once. Scopes (`billing:read`, `assistant:use`, …, with `ns:*` and `*`
for admins) are checked before the handler runs; a monthly quota is counted on
every call and answers 429 once exceeded, with `x-quota-used` / `x-quota-limit`
on every response so clients can back off before being cut off. Unknown and
revoked keys return the same 401 — a distinct message would confirm the key
once existed.

## Layout

```
src/
  domain/          pure, no I/O — the rules, and the only place they are written
    billing-event.ts   IBillingProvider + neutral DTOs (the contract)
    subscription.ts    status enum + legal transitions + event mapping
    entitlements.ts    plans, features, quotas; entitlements as a pure function
    plan-change.ts     when a plan may move, and how long a quoted price holds
    membership.ts      which tenant a signed-in caller may act for
  providers/
    stripe.ts      the ONLY file importing `stripe`
    fake.ts        in-memory provider — full flow with no Stripe account
  server/
    billing.service.ts  the only place a subscription status changes
    usage.ts            metered quota
    with-session.ts     session → tenant, for human callers
  app/
    api/webhooks/stripe  verify → claim → apply
    api/auth             Auth.js magic-link sign-in
    api/checkout         start a subscription (tenant from the session)
    api/keys             mint / revoke API keys (hash stored, raw shown once)
    api/assistant        a paid feature: api key → scope → entitlement → quota
    api/portal           a link into Stripe's billing portal, for the caller's tenant
    api/plan-change      quote a proration, then change plan at the quoted price
    [locale]/            pricing and account pages, en + vi
tests/               64 unit + 26 integration against real Postgres
```

## Run it

```bash
pnpm install
cp .env.example .env        # fill in Stripe test keys and an SMTP url
pnpm db:up                  # Postgres on :5433
pnpm db:push
pnpm dev

# in another terminal — gives you STRIPE_WEBHOOK_SECRET
pnpm stripe:listen
```

Sign in at `/api/auth/signin` — Auth.js's own page is enough to click a magic
link. First sign-in provisions a tenant for the address, or joins the tenant
already seeded with it. `/account` then shows what that tenant may do and the
link into Stripe's portal; the portal needs to be enabled once, in the Stripe
dashboard under Settings → Billing → Customer portal.

```bash
pnpm test        # unit tests run anywhere; integration tests need DATABASE_URL
pnpm typecheck
```

CI runs typecheck plus the full suite against a real Postgres service container
on every push.

## What is deliberately not here

- **A plan picker on the account page.** Plan changes are quoted and confirmed
  over `/api/plan-change`; the two-step flow has no UI in front of it yet.
- **A dunning schedule.** `PAST_DUE` is entered and left correctly, but nothing
  emails the customer or decides when retries run out.
- **Tax, invoices, receipts.** Stripe Tax and hosted invoices cover this better
  than an application ever will.
- **Invites and roles.** A membership is provisioned for the address that signs
  in; there is nothing that adds a second person to a tenant, and every member
  can do everything. A user who belongs to several tenants can say which one on
  the API with `x-tenant-id`, but the account page has no picker.
- **A real model call.** `/api/assistant` returns a stub. The entitlement and
  quota gates in front of it are the part that has to be right first.
