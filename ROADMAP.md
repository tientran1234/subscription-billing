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
- [x] Invoice history on the account page, read live from Stripe with hosted PDF links — no local copy of invoice data to drift.
- [x] Spend cap: a workspace sets a ceiling on how far past its quota it will be billed; the request that would pass it is refused and the month's report is clamped to it, so the cap holds on the invoice and not only on the page.
- [x] Cap warning: a workspace is written to as its spend cap comes up and again on the first call refused at it; one mail of each kind per month, claimed the way a dunning notice is.
- [x] Notices in the workspace's language: a tenant records the locale it is written to in, set on the account page, and the dunning and cap-warning mails are subject-lined, composed and linked in it.
- [x] The notice language on the gateway's own customer: setting a workspace's locale writes it across to the provider's customer record, so the receipts and card-expiry warnings the gateway composes itself arrive in the language this application already writes in.
- [x] The whole invoice archive: the account page pages back through the gateway's own cursor, so a customer can read behind the first twelve invoices without being sent to the portal for them.
- [x] Invites: a workspace offers a seat to an address and the invite holds it until that address signs in, it is withdrawn or it expires, with a member removable to free one; roles stay out, so every member can still do everything.
- [x] Roles: an admin may change the workspace — its plan, seats, cap, notice language, credentials and who else is in it — while a member may read all of it and change none, with leaving the one change a member may still make and the last admin neither removable nor demotable.
- [x] A picker for a user who belongs to several workspaces: the account and transactions pages act on `ambiguous` with a list of the workspaces the session grants, and the one chosen is remembered so the pages and routes that follow resolve to it.
- [x] A real model call behind the gates: an `IAssistantProvider` port whose only vendor-aware file is the model's adapter, a deterministic fake the end-to-end suite and CI run on, and the metered unit given back when a call produces no message.
- [x] The history of who could do what: every role a workspace hands out is recorded with who granted it and when, listed on the transactions page, so it can say when somebody became an admin and who made them one.
- [x] A threshold the customer picks: the line below the cap a warning goes out at becomes a whole percent on the workspace, set on the account page and read with the cap in one row, with the default kept for every workspace that never picks one.
- [ ] A way back up the invoice archive: the window in front of this one is read through the gateway's own backward cursor, so paging past what you were looking for is one step back rather than a return to the newest.
