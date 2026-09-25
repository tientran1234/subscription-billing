# Changelog

## 2026-09-25

- Plan change with proration preview (`stripe.invoices.retrieveUpcoming`) before confirming; the state machine gains a `planKey` change on a paid invoice — so the customer is billed the amount they were shown, and the plan only moves once the invoice for it is paid.

## 2026-09-24

- Stripe Customer Portal link on the account page (cancel, update card) — the app never edits subscriptions itself, so the status a subscription reaches still has exactly one writer: the webhook.

## 2026-09-23

- Session auth: Auth.js magic-link sign-in; `tenantId` comes from the session, never the body; ownership checks on checkout and key minting — so a signed-in caller can no longer start a subscription or mint a key against a tenant they do not belong to.
