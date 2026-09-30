# Changelog

## 2026-09-30

- Trials: `trialDays` on a plan adds a `TRIALING` status under the same forward-only rules, entitlements during trial equal the plan, and the trial-ending webhook is handled idempotently like every other — a trial had nowhere to live but an early `ACTIVE`, which cannot tell a lapsed trial from a failed renewal and would let a replayed delivery hand a paying customer a second free month.

## 2026-09-29

- Plan picker on the account page: quote the proration, show what is due now, confirm at the quoted price — the two-step flow had no UI in front of it, and the buttons it draws come from the rule the route enforces, so the page cannot offer a change that is then refused.

## 2026-09-28

- Playwright end-to-end: checkout with a test clock, webhook replay, entitlement drop on cancel — the three claims a customer would notice are now checked through the real routes in a browser, against the in-memory gateway because CI has no Stripe account.

## 2026-09-27

- Admin transactions page: filters plus cursor pagination over subscriptions and API-key usage — a keyset cursor rather than an offset, so a checkout landing while the list is being read cannot serve one row twice and hide another.

## 2026-09-26

- Dunning hooks: on `PAST_DUE` send a react-email template, on `CANCELED` a goodbye, both idempotent per event id — the customer hears about a failed renewal in time to fix it, and hears it exactly once however often the webhook is delivered.

## 2026-09-25

- Plan change with proration preview (`stripe.invoices.retrieveUpcoming`) before confirming; the state machine gains a `planKey` change on a paid invoice — so the customer is billed the amount they were shown, and the plan only moves once the invoice for it is paid.

## 2026-09-24

- Stripe Customer Portal link on the account page (cancel, update card) — the app never edits subscriptions itself, so the status a subscription reaches still has exactly one writer: the webhook.

## 2026-09-23

- Session auth: Auth.js magic-link sign-in; `tenantId` comes from the session, never the body; ownership checks on checkout and key minting — so a signed-in caller can no longer start a subscription or mint a key against a tenant they do not belong to.
