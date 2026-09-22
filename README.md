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
  providers/
    stripe.ts      the ONLY file importing `stripe`
    fake.ts        in-memory provider — full flow with no Stripe account
  server/
    billing.service.ts  the only place a subscription status changes
    usage.ts            metered quota
  app/
    api/webhooks/stripe  verify → claim → apply
    api/checkout         start a subscription
    api/keys             mint / revoke API keys (hash stored, raw shown once)
    api/assistant        a paid feature: api key → scope → entitlement → quota
    [locale]/            pricing page, en + vi
tests/               29 unit + 12 integration against real Postgres
```

## Run it

```bash
pnpm install
cp .env.example .env        # fill in Stripe test keys
pnpm db:up                  # Postgres on :5433
pnpm db:push
pnpm dev

# in another terminal — gives you STRIPE_WEBHOOK_SECRET
pnpm stripe:listen
```

```bash
pnpm test        # unit tests run anywhere; integration tests need DATABASE_URL
pnpm typecheck
```

CI runs typecheck plus the full suite against a real Postgres service container
on every push.

## What is deliberately not here

- **Proration and plan changes.** Mid-cycle upgrades need Stripe's proration
  behaviour mirrored locally, or two sources of truth disagree about money.
- **A dunning schedule.** `PAST_DUE` is entered and left correctly, but nothing
  emails the customer or decides when retries run out.
- **Tax, invoices, receipts.** Stripe Tax and hosted invoices cover this better
  than an application ever will.
- **Human auth.** Machine callers authenticate with API keys; a person minting a
  key or starting a checkout still passes `tenantId` in the body. In a real
  deployment that comes from the session, and those routes gain an ownership
  check.
- **A real model call.** `/api/assistant` returns a stub. The entitlement and
  quota gates in front of it are the part that has to be right first.
