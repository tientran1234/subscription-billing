# subscription-billing

A small SaaS billing slice, built to be correct where billing usually goes wrong:
duplicate webhooks, webhooks that arrive out of order, and access that outlives
the subscription that paid for it.

Stripe subscription checkout → signed webhook → idempotent event log →
forward-only state machine → entitlements derived on read. Next.js App Router,
Postgres via Prisma, English and Vietnamese, dollars and dong.

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

**An invoice is Stripe's document, not a row here.**
The account page lists what this workspace has been invoiced, read off the
gateway as the page loads and copied into nothing. An invoice carries the tax
Stripe worked out, the card it charged and the PDF a customer's accountant will
ask for, and it keeps changing after it is raised — a payment retried, an amount
written off, a credit note against it — so a copy here would be a second answer
to what somebody was charged, stale from the moment it was written and
disagreeing with the document the customer can already open. The links are
rendered with the page, which is the one way this differs from the portal link
beside it: a portal session is single-use and dead in minutes, while a hosted
invoice and its PDF live on the invoice itself. What is left to decide is which
invoices are history, and a draft is not one — it is the invoice the gateway is
still assembling for a period nobody has been billed for, its total can still
move, it carries no number and there is no document behind it to open, so
showing one tells a customer they were charged an amount nobody has asked them
for. `void` and `uncollectible` do show: an invoice that was cancelled or
written off is still part of what happened on the account, and leaving it out
would make a month simply disappear. The rule runs after the read rather than
being asked of the gateway, because Stripe's list takes exactly one status and
half a rule in an adapter is a rule the next adapter gets wrong; it costs at
most one row of the window, since one draft is assembled per subscription at a
time. The customer it reads for is the one the portal opens for, through the
same lookup — a page listing one customer's invoices beside a button opening
another's would be two answers to a question that may only have one — and a
gateway that cannot be reached says so, because "no invoices" is also exactly
what a customer holding twelve of them would then be shown.

**A trial is the plan, on a status of its own.**
`trialDays` on a plan is what a checkout asks the gateway for, read off
`PLANS` rather than accepted from the route, so nobody can ask for a longer
trial than we sell. It comes back as `TRIALING`, which is a status and not an
early `ACTIVE`, because the state machine has to be able to tell a trial that
lapsed from a renewal that failed — and because `ACTIVE → TRIALING` is then not
legal, so a late or replayed trial-start delivery cannot hand a paying customer
a second free month. Entitlements during the trial are the plan's own: a trial
exists so the customer can judge what they would be buying, and spent on Free it
would judge a product nobody is selling them. Reading the trial back is the
awkward half, because a completed checkout on a trialling plan has taken no
money and Stripe's session object carries no trial field to say why — so
`createCheckout` writes the trial into the session metadata and normalization
reads it there, the route `planKey` already takes. Without that the session
would activate the subscription in the same instant the trial began, and the
first real invoice would arrive as a renewal of a month nobody was charged for.
The trial ending is handled like every other delivery and moves nothing: the id
is claimed, the event is recorded under its own type rather than as `unknown`,
and that is all, because which outcome follows — an invoice paid or one refused
— is the gateway's to report in its own event rather than ours to guess. Nothing
is mailed about it either; the mail that matters is the failed payment after it,
which the dunning hooks already send. A trial cannot change plan, for the reason
`PAST_DUE` cannot: there is no invoice being billed to prorate against.

**A seat is a quantity, and the ones in use are a floor.**
`seats` on a checkout is the `quantity` on the provider's price, and it is
recorded on the subscription because that is what was bought. It comes back the
way `planKey` does — off the metadata the paid invoice snapshots, and
deliberately not off its line items, because a proration invoice has several
lines in no promised order and the quantity on the first of them may be the one
being credited rather than the one being charged. A seat change is therefore
evidence that money was taken, which keeps `applyEvent` the only writer of what
a tenant has. Entitlements derive the count like they derive the plan, so a
cancelled workspace falls back to the one seat its owner holds; features and
quotas stay the workspace's, because buying a seat buys a person access and not
another month's worth of messages. The floor is the part a gateway will not do
for you: dropping below the seats in use pays for itself by taking somebody's
access away, and nothing in the credit note says whose. So the count in use —
read from the workspace's own memberships rather than assumed to be one — is
refused before anything is quoted, at checkout as much as on a change, and
whoever is leaving is removed first. A plan move that names no seats keeps the
ones already paid for: defaulting to one there would take four seats off a
workspace mid-upgrade and bill them a proration for it. The picker folds the
eligibility rule over the number in the field rather than over a set rendered
with the page, because which plans may be moved to depends on the count being
asked for — and confirming sends the count that was quoted rather than the one
in the field, so the price on the screen is the price for those seats.

**A price is per currency, and the currency is chosen once.**
A plan carries an amount per currency rather than one converted at read time:
a rate that moves would reprice the catalogue between the page a customer read
and the invoice they are sent, and a price list is a round number somebody
chose rather than today's arithmetic. The locale picks which one a page quotes,
because a Vietnamese price list in dollars is one nobody can act on, and the
checkout sends the currency it quoted — refused if no plan is priced in it,
before a row is written and before a session is opened, the same shape the seat
floor is refused in. What was bought is recorded on the subscription, and unlike
the plan and the seats it never moves again: the gateway fixes a subscription's
currency when it creates it and will not reprice a live one into another, so a
plan change reads the currency off our own row and accepts none from the
caller. For the same reason no event carries one — there is nothing for a
webhook to move, and a second writer of something already settled is how two
copies come to disagree. It stays one price id per plan, because a Stripe Price
carries an amount per currency of its own (`currency_options`); a price id per
plan per currency would be this table again, in an environment file, free to
drift from it. The division into major units is the half that goes wrong
quietly: the dong has no subdivision, so its minor unit is the dong, and the
hundred every other amount here needs would quote a Vietnamese customer a price
a hundred times too small. It is written once, in `src/domain/currency.ts`, and
the pricing page and the proration quote both go through it.

**A quota is a ceiling or a threshold, and a month is reported once.**
Which of the two it is belongs to the plan. Free stops at its fifty messages
because there is no subscription for a usage record to attach to; a plan that
sells the metered add-on bills what is used past its allowance instead of
refusing the call. Only the units past the quota are ever reported — the plan
has already paid for everything up to it, so sending the raw counter would
charge twice for the messages it includes. Whether a call may go past is read
off the entitlement rather than the row underneath it, so the instant a
workspace stops being billed for exceeding its quota is the instant it stops
being let past: a trial is deliberately not a status that bills, because it
takes no money and one that ends with an invoice for the messages it was spent
judging the product on is not a trial, while `PAST_DUE` is one, for the same
reason it keeps paid access. The add-on is bought at checkout as a second,
metered item beside the plan's own — with no quantity on it, because what it
charges for is the usage reported against it — and it is recorded on the
subscription, since one opened before the add-on was sold has no meter to
report to and must not be let past its quota afterwards. Two items in no
promised order is also why the plan change finds the licensed one by its price
rather than taking whichever the gateway lists first: repricing the meter would
bill a customer for a plan they never chose, and a usage record against the
licensed item is refused outright.

**The overage job is idempotent per period, not per run.**
The figure is a month's, and the month has to be over: a report is claimed once
per period, so one raised while the month was still running would spend that
claim on a partial figure and bill none of the rest. The claim is the guarantee
rather than the scheduler — `UsageReport` is keyed by (subscription, period),
written before the report and released if the gateway refuses it, the same
shape a dunning notice is claimed in — so a cron that fires twice, a retry
after a crash and a run by hand all bill the month once. A closed month's
counter cannot move again, which is what makes that figure worth claiming: the
number a second run computes is the number the first one sent. The job reports
a workspace's newest subscription and no other, because the counter belongs to
the workspace rather than to one of its subscription rows, and a job that
walked the rows would bill a workspace that cancelled and subscribed again once
per row. What reaches the gateway adds to its period rather than setting it: a
billing cycle is not a UTC month, two of ours can fall inside one of theirs,
and a write that set the figure would overwrite the first with the second. It
carries the period in an idempotency key of its own as the second line of
defence, and no timestamp at all — a usage record has to be dated inside the
subscription's current billing period, and the month being reported has by
definition closed.

**A spend cap is the customer's ceiling, in units, clamped where the money is.**
A plan that sells the add-on turns its quota into a threshold, and the only
other limit on a month's invoice is how often the key is called. A cap is the
workspace's own answer to that, so it is set here rather than at the gateway,
which is never told it exists. It counts units past the quota and not money:
units are the figure this application owns — `meter` counts them and the report
carries them — while a unit's price is Stripe's, so a ceiling in money would
have to be divided by a figure the customer cannot see and would silently buy
them fewer messages the day that price moved. Zero is a cap a customer may set,
and means the quota is a ceiling again; no cap at all is a different answer from
zero, which is why the column is nullable and why every workspace from before
caps existed goes on being billed for the add-on it pays for. It lives on the
tenant rather than the subscription, because the subscription's columns mirror
what the gateway sold and move on its webhooks, while a cap outlives a workspace
that cancels and subscribes again — exactly as its usage counters do. The cap
holds in two places or it holds in neither: `/api/assistant` refuses the request
that would take the month past it, and the report clamps the figure it sends.
The clamp is the half that is about money and the half that has to be right,
because the counter goes on counting calls that are refused — a month that ran
into its ceiling ends with a counter above it, and reporting `used - limit` would
invoice for precisely the units the cap was set to prevent.

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
stored, so it moves the dates and nothing else. The account page is where a
customer does this: the picker draws a button only for the plans
`planChangeOptions` allows — the eligibility rule folded over `PLANS`, so the
page cannot offer a change the route then refuses — and it asks for the price
on the click rather than with the page, because a proration rendered at page
load is stale before anyone reads it.

**A dunning notice is claimed before it is sent.**
A failed renewal mails the customer; a cancellation says goodbye. Both claim
the provider's event id in `DunningNotice` before anything is rendered, so a
second attempt loses on the primary key rather than on a check of whether a
mail already went out — the same shape as `applyEvent`, and it holds for a
manual replay and not just for the one caller that runs first today. Sending
happens after `applyEvent` and never inside it: the route answers 200 once the
signature verifies, and a mail server that is down must not make Stripe
redeliver a status change that already landed. A refused send is therefore an
outcome rather than an exception, and it deletes its own claim, because a row
there means a mail went out and one that did not would block the retry as well
as lie. Only a transition that really happened is worth writing about, so the
notice reads the outcome: a replay, a lost race, and a renewal on an
already-active subscription all mail nobody. The past-due mail links to the
account page rather than to a portal link — the provider's are single-use and
expire in minutes, so one minted at send time would be dead on arrival.

**A cap warning is claimed per month, because there is no event to claim.**
A ceiling the customer cannot see coming is a key that stops working
mid-month, so `/api/assistant` writes to them twice: once at four fifths of the
cap, while the add-on is still serving calls and the ceiling can still be
moved, and once on the first call it refuses. It is sent from that request and
not from a job, because the news is that a key has just started failing and a
nightly sweep would say it a day late — and because the request already holds
both figures, having metered the call and read the cap to decide whether to
serve it. The claim is the same shape as a dunning notice's with the one part a
counter cannot borrow: nothing was delivered, so there is no event id to key
it by. A counter that has crossed a line stays crossed for every call after it,
and without a claim a workspace sitting at 81% of its cap would be mailed once
per request for the rest of the month — so `CapNotice` is keyed by (tenant,
month, kind), the second request past the line loses the insert, a refused send
deletes its own row rather than silencing the month, and the month rolling over
is what makes it news again. The mail is sent before the refusal is returned
and its failures are swallowed, for the reason the dunning hook swallows
them: a gate in front of a paid feature must not start refusing calls because
a mail server is down.

**A notice is written in the language the workspace recorded, not the one a
page was last rendered in.**
The pages take their locale from the URL and let next-intl negotiate it against
the browser. A notice has neither: it is composed by a webhook Stripe sent, or
by the request that ran a month into its cap, and in both there is no reader
attached and no address to read a language off. So the language is a column on
the tenant, set on the account page, and null on it is kept distinct from the
default — a workspace that has never chosen is not one that chose English, and
keeping the two apart is what lets a second default be argued about later
without overruling the rows that asked for the first. A locale we do not
publish reads as nothing said rather than as an error, because a notice that a
renewal failed is worth more in the wrong language than not at all. The copy
comes off the same message files the pages use, through a translator that needs
no request, so there is one place to write a sentence and the two files have to
agree key for key or the build says so. The links carry the prefix too: a mail
written in Vietnamese that opens `/en/account` has given up the half of the
language the reader actually clicks on. What Stripe sends — the receipts, the
card-expiry warnings — is composed by Stripe from its own customer record, and
this column has no say in it.

**A replay is the same delivery, asked for a second time.**
An endpoint that was unreachable for an hour leaves a subscription behind the
money that paid for it, and Stripe's retries do not come back once they have
run out. `/api/replay` takes a provider event id, re-fetches that event from the
gateway and hands it to the same `applyEvent` and the same `notifyDunning` the
webhook route calls, in the same order, so a replay inherits the guarantees
instead of restating them: the id is claimed in `WebhookEvent`, the transition
is still conditional in Postgres, and a replayed failed renewal writes to a
customer who was never told while one that did arrive writes to nobody. The
event is read off the gateway and never taken from the request — a payload
posted by hand carries no signature, and accepting one would make this a second,
unsigned writer of everything `applyEvent` decides. The dangerous half is not
idempotency but ownership: an event id names something at Stripe rather than
anything here, so the event is tied back to a subscription first and that
subscription has to be the caller's own, or any signed-in member could type
another workspace's id and move its subscription. The three ways that check can
fail — no such event, no subscription, another workspace — come back as one 404,
because distinguishing them would answer which event ids are real in somebody
else's ledger. `EventReplay` keeps them apart on the inside, with who asked and
what came of it. It is keyed by its own id rather than the event's, since the
same event may be replayed more than once and the attempts after the first are
the ones an audit is read for, and the row is written before the work with its
outcome filled in after: the audit is not a lock — the event id already is one —
so claiming early costs nothing and an attempt that died halfway still names
whoever made it. The in-memory gateway remembers what it delivered only for the
life of one adapter, and the app builds one per request, so unlike the claims
below this one is pinned against the service rather than through a browser.

**Reading a ledger uses a cursor, not an offset.**
The transactions page lists subscription attempts and per-key usage newest
first. `LIMIT n OFFSET n` counts from the start of the result on every request,
so a checkout that lands while someone is on page one slides the boundary down
and page two repeats a row while hiding another — on a list of what a customer
was charged, that is the wrong kind of wrong. A cursor names the last row
served instead, and it is a `(createdAt, id)` pair because two rows written in
the same millisecond would otherwise both sit exactly on the boundary. One row
past the page is fetched to decide whether there is a next one, so no COUNT
grows slower as the table does. The keys are paged before their usage counters
are read, never the other way round: a counter row only exists once a call has
been metered, so joining from the counters would drop every key that has not
been used — which is the row anyone auditing spend is looking for.

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

**The end-to-end suite drives the app, not Stripe.**
The three claims a customer would notice — a checkout becomes access, a
replayed webhook changes nothing, access ends with the subscription — are
pinned against `applyEvent` by the unit suite and against a browser by
`tests/e2e`. Those runs need a gateway and CI has no Stripe account, so
`BILLING_PROVIDER=fake` puts the in-memory adapter behind the real routes,
refused once `NODE_ENV` is production because an adapter that signs its own
webhooks would accept anybody's. That leaves the one thing a fake cannot stand
in for: a renewal falls due a month after checkout, which is what Stripe's test
clock exists to skip. So the suite is the clock — it holds the instant,
advances it, and posts the deliveries the gateway would have made by then, as
raw signed bytes at the endpoint Stripe posts to. Signing in seeds the session
row the Auth.js adapter would have written rather than running an SMTP catcher
in CI; the magic link has its own tests, and billing is what this one is for.

## Layout

```
src/
  domain/          pure, no I/O — the rules, and the only place they are written
    billing-event.ts   IBillingProvider + neutral DTOs (the contract)
    subscription.ts    status enum + legal transitions + event mapping
    entitlements.ts    plans, features, quotas; entitlements as a pure function
    currency.ts        the currencies we sell in, and what a minor unit is worth
    invoice.ts         what an invoice history is, and what is not in one
    overage.ts         what is owed past the quota, and when a month may be billed
    spend-cap.ts       the ceiling a workspace sets on what it will be billed
    cap-warning.ts     which line of that ceiling is worth writing to them about
    notice-locale.ts   which language a workspace is written to in, and its links
    plan-change.ts     when a plan may move, and how long a quoted price holds
    seats.ts           how many seats we sell, and the floor the ones in use set
    membership.ts      which tenant a signed-in caller may act for
    dunning.ts         which status a customer is worth writing to about
    replay.ts          who may replay a provider event, and whose it has to be
    transactions.ts    cursor ordering and the filters the ledger may be read by
  providers/
    index.ts       which adapter the routes get — Stripe unless asked otherwise
    stripe.ts      the ONLY file importing `stripe`
    fake.ts        in-memory provider — full flow with no Stripe account
  emails/          react-email templates; HTML and plain text off one tree
    copy.ts            their words, in the reader's language, off the page messages
  server/
    billing.service.ts  the only place a subscription status changes
    usage.ts            metered quota
    usage-report.ts     one closed month of overage, reported at most once
    spend-cap.ts        the tenant's own ceiling, where null is an answer
    tenant-locale.ts    the language it reads, where null is a different answer
    dunning.ts          claim the event id, render, send — at most once
    cap-warning.ts      claim the month, render, send — at most once a month
    replay.ts           re-fetch one event, re-apply it, record who asked
    mailer.ts           the SMTP seam, so tests can read what was composed
    with-session.ts     session → tenant, for human callers
    transactions.ts     the two paginated reads behind the transactions page
  app/
    api/webhooks/stripe  verify → claim → apply → notify
    api/auth             Auth.js magic-link sign-in
    api/checkout         start a subscription (tenant from the session)
    api/keys             mint / revoke API keys (hash stored, raw shown once)
    api/assistant        a paid feature: api key → scope → entitlement → quota,
                         and the mail when that quota's ceiling comes up
    api/portal           a link into Stripe's billing portal, for the caller's tenant
    api/plan-change      quote a proration, then change plan at the quoted price
    api/replay           re-apply one provider event by id, for the caller's tenant
    api/usage-report     report a closed month's overage, for a `billing:write` key
    api/spend-cap        read or move the ceiling on this workspace's overage
    api/locale           read or set the language this workspace is written to in
    [locale]/            pricing, account and transactions pages, en + vi
tests/               229 unit + 129 integration against real Postgres
  e2e/               Playwright: checkout, replay, the cancel drop, the plan
                     change, the invoice list, the spend cap
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
already seeded with it. `/account` then shows what that tenant may do, the
plans it can move to, the seats it is paying for, the ceiling it has set on what
it will be billed past its quota, the language it is written to in, the invoices
it has been issued, and the link into Stripe's portal; the portal needs to be
enabled once, in the Stripe dashboard under Settings → Billing → Customer
portal. `/admin` lists that tenant's subscription
attempts and what each API key spent, a page at a time, and is where an event
the endpoint missed is replayed by id.

A closed month's overage is reported by posting to `/api/usage-report` with an
API key scoped `billing:write` — once a month, from whatever cron the
deployment has. Posting it twice bills nothing twice, so a scheduler that fires
late or fires again is safe to point at it.

```bash
pnpm test        # unit tests run anywhere; integration tests need DATABASE_URL
pnpm test:e2e    # Playwright; starts the app itself, also needs DATABASE_URL
pnpm typecheck
```

CI runs typecheck plus the full suite against a real Postgres service container
on every push, and the end-to-end suite beside it in a job with a browser.

## What is deliberately not here

- **A dunning schedule.** Entering `PAST_DUE` and leaving it now mails the
  customer, but nothing here decides when the retries run out: Stripe's own
  retry settings do, and the cancellation they end in arrives as a webhook like
  any other. The mails are composed in the language the workspace recorded, but
  what Stripe itself sends — the receipt, the card-expiry warning — is composed
  by Stripe from the language on its own customer record, and nothing here
  writes this column across to it.
- **Tax and receipts.** Stripe Tax and Stripe's hosted documents cover this
  better than an application ever will. The account page lists the invoices and
  links to each one, but nothing here composes a document, works out what is
  owed in tax, or sends a receipt.
- **The whole invoice archive.** The list is the last twelve, which is as far
  back as anyone reads on the way to downloading one; the rest are in Stripe's
  portal, which the same page already links to. Paging this would mean paging
  the gateway, and the page it would end in is the one Stripe already hosts.
- **Invites and roles.** A membership is provisioned for the address that signs
  in; there is nothing that adds a second person to a tenant, and every member
  can do everything. Seats are sold and billed per person all the same, and the
  floor under a reduction is counted from those memberships rather than assumed
  — the day invites land is not the day to remember that seats had a rule. That
  is also what "admin" means on the transactions page — the workspace the caller
  belongs to, not a view across tenants. A user who belongs to several tenants
  can say which one on the API with `x-tenant-id`, but the account page has no
  picker.
- **An end-to-end run against Stripe itself.** The suite drives the real
  routes with the in-memory gateway, so it proves this application's guarantees
  and none of Stripe's. Pointing it at a test-mode account and a real test
  clock would need credentials CI does not have, and would then fail for
  Stripe's outages as readily as for a bug here.
- **Converting between currencies.** Each price is chosen per currency rather
  than computed from a rate, so nothing here reads one — and nothing moves a
  live subscription from one currency to another, because the gateway will not:
  a customer who wants to be billed in the other one cancels and subscribes
  again. Local payment methods and per-currency tax are Stripe's to configure.
- **A threshold the customer picks, or a word to a workspace with no ceiling.**
  The warning goes out at four fifths of the cap, which is a constant in
  `domain/cap-warning.ts` rather than a field beside the cap on the account
  page: a second number to set is a second number to explain, and the month a
  customer wanted it at nine tenths they can say so by raising the cap. A
  workspace that set no cap hears nothing at all, because it has no line to
  cross — what it would want warning about is the size of the bill, and turning
  the counter into money needs the gateway's prices, which is the same reason
  the cap counts units.
- **A scheduler.** The overage job is a route a machine credential posts to;
  what calls it once a month is the deployment's cron. A single run across
  every workspace would need an operator credential, which is the same thing
  invites and roles are missing above — so the job is scoped to the caller's
  own tenant, and a month nobody asks about is simply not reported. The claim
  means a late run still bills it correctly, not that one happens.
- **Overage on the invoice for the month it was used in.** A usage record is
  billed on whichever of the gateway's own periods is open when it arrives, and
  a UTC month is our quota bucket rather than its billing cycle — so September's
  overage rides the next invoice instead of September's. Lining the two up would
  mean counting the quota on the subscription's anniversary, which is a
  different product.
- **A real model call.** `/api/assistant` returns a stub. The entitlement and
  quota gates in front of it are the part that has to be right first.
