# Roadmap

One item per pull request, in order.

- [x] Session auth: Auth.js magic-link sign-in; `tenantId` comes from the session, never the body; ownership checks on checkout and key minting.
- [x] Stripe Customer Portal link on the account page (cancel, update card) — the app never edits subscriptions itself.
- [x] Plan change with proration preview (`stripe.invoices.retrieveUpcoming`) before confirming; state machine gains `planKey` change on a paid invoice.
- [x] Dunning hooks: on `PAST_DUE` send a react-email template; on `CANCELED` a goodbye; both idempotent per event id.
- [x] Admin transactions page: filters + cursor pagination over subscriptions and API-key usage.
- [x] Playwright end-to-end: checkout with a Stripe test clock, webhook replay, entitlement drop on cancel.
- [x] Plan picker on the account page: quote the proration, show what is due now, confirm at the quoted price.

## Batch 2 — set by the owner, 30 Sep 2026

Same rule: one item per change, in order.

- [x] Trials: `trialDays` on a plan adds a `TRIALING` status under the same forward-only rules; entitlements during trial equal the plan; the trial-ending webhook is handled idempotently like every other.
- [x] Seats: `quantity` on checkout and subscription, seat count in entitlements, proration preview on seat change, and a guard that refuses to drop seats below the seats in use.
- [x] Webhook replay: an admin action that re-fetches a Stripe event by id and re-applies it through the same idempotent path; who replayed what is written to an audit table.
- [x] Multi-currency: prices per currency with the customer's currency chosen at checkout; entitlements and the state machine unchanged, proven by the existing tests running across two currencies.
- [x] Metered add-on: usage beyond the plan quota billed through Stripe usage records, reported once per period by a durable job that is idempotent per period.
- [ ] Invoice history on the account page, read live from Stripe with hosted PDF links — no local copy of invoice data to drift.
