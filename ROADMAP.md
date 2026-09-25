# Roadmap

One item per pull request, in order.

- [x] Session auth: Auth.js magic-link sign-in; `tenantId` comes from the session, never the body; ownership checks on checkout and key minting.
- [x] Stripe Customer Portal link on the account page (cancel, update card) — the app never edits subscriptions itself.
- [x] Plan change with proration preview (`stripe.invoices.retrieveUpcoming`) before confirming; state machine gains `planKey` change on a paid invoice.
- [ ] Dunning hooks: on `PAST_DUE` send a react-email template; on `CANCELED` a goodbye; both idempotent per event id.
- [ ] Admin transactions page: filters + cursor pagination over subscriptions and API-key usage.
- [ ] Playwright end-to-end: checkout with a Stripe test clock, webhook replay, entitlement drop on cancel.
