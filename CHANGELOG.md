# Changelog

## 2026-10-09

- The notice language on the gateway's own customer: setting a workspace's locale writes it across to the provider's customer record, so the receipts and card-expiry warnings the gateway composes itself arrive in the language this application already writes in — the column decided only half of what a workspace received, and a product that mails in Vietnamese while its gateway mails in English about the same failed renewal is one the customer has to read twice; the column is written first and the gateway asked second, because the column is ours to guarantee and its copy is ours only to ask for, so a gateway having a bad minute is reported beside the saved choice rather than costing the customer the choice they just made.
- Notices in the workspace's language: a tenant records the locale it is written to in, set on the account page, and the dunning and cap-warning mails are subject-lined, composed and linked in it — a notice is the one thing here read away from the app, composed by a webhook or by the request that ran a month into its cap, so there is no URL and no reader to negotiate a language from and the workspace's own answer has to be a column; null on it is kept apart from the default because a workspace that never chose is not one that chose English, and the link carries the prefix too, since a mail written in Vietnamese that opens /en/account has given up the half of the language the reader clicks on.

## 2026-10-08

- Cap warning: a workspace is written to as its spend cap comes up and again on the first call refused at it, one mail of each kind per month and claimed the way a dunning notice is — a ceiling the customer set once and only the account page repeats is a key that stops working mid-month with no warning, and the claim has to be keyed by the month because nothing was delivered to key it by and a counter that has crossed a line stays crossed for every call after it.

## 2026-10-07

- Spend cap: a workspace sets a ceiling on how far past its quota it will be billed, the request that would pass it is refused and the month's report is clamped to it — a plan that sells the metered add-on turns its quota into a threshold, so without a ceiling the only limit on an invoice was how often the key was called, and because the counter goes on counting the calls that are refused, the clamp in the report rather than the refusal in the route is what keeps those units off the bill.

## 2026-10-06

- Invoice history on the account page, read live from Stripe with hosted PDF links and no local copy of invoice data to drift — the one thing a customer comes to a billing page for was the one thing it did not show, and a copy of an invoice would be a second answer to what they were charged, since an invoice goes on changing after it is raised and the document they can already open is the one that is right.

## 2026-10-05

- Metered add-on: usage beyond the plan quota billed through Stripe usage records, reported once per period by a durable job that is idempotent per period — a quota that refuses the call is a product decision rather than a billing one, and the job can only be safe to re-run if the month it reports has closed and the month it claims is a primary key.

## 2026-10-04

- Multi-currency: prices per currency with the customer's currency chosen at checkout, entitlements and the state machine unchanged and proven by the existing tests running across two currencies — one price list in dollars is one half the customers here cannot act on, and the currency has to be settled at checkout because the gateway will not reprice a live subscription into another one.

## 2026-10-03

- Webhook replay: an admin action that re-fetches a Stripe event by id and re-applies it through the same idempotent path, with who replayed what written to an audit table — a delivery that never arrived had no way back in short of the Stripe dashboard, and re-applying one by hand is only safe because the event is re-read from the gateway, tied to a subscription in the caller's own workspace, and claimed by the same primary key a live delivery is.

## 2026-10-02

- Seats: `quantity` on checkout and subscription, seat count in entitlements, proration preview on seat change, and a guard that refuses to drop seats below the seats in use — the gateway will happily reprice a workspace down to fewer seats than it has people, and nothing in the credit note says whose access paid for the reduction.

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
