# Changelog

## 2026-09-24

- Stripe Customer Portal link on the account page (cancel, update card) — the app never edits subscriptions itself, so the status a subscription reaches still has exactly one writer: the webhook.

## 2026-09-23

- Session auth: Auth.js magic-link sign-in; `tenantId` comes from the session, never the body; ownership checks on checkout and key minting — so a signed-in caller can no longer start a subscription or mint a key against a tenant they do not belong to.
