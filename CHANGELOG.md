# Changelog

## 2026-10-26

- A past for the settings a workspace sets on itself: the spend cap, the warning line and the notice language each record what they became and who moved them, listed beside the role grants on the transactions page — all three were columns that overwrote the one before, so a workspace could read what its cap is today and not who dropped it under a month of usage, which is the question asked after the change nobody meant to make; the change is written in the transaction that moves the column, as a role grant is written with the membership it describes, so no row can name a value the column never took and no move can go unrecorded; the account comes off the session rather than the body, because a row whose author the caller could name is worth nothing, and there is deliberately no way to move one of these figures without saying who did; a save that left a setting as it was records nothing, which is what keeps the date beside a figure the date it was set rather than the date somebody last opened the account page and pressed save; the value is kept as text and null is one of its values — the cap lifted, the line put back to its default — because the figure is only ever read back to be shown and a history consulted instead of the column would be a second answer to what a workspace agreed to be billed; there is no column for the value replaced, as there is none for the role replaced, since a row written only when something moved makes the row below it the value before; and the plan stays out, because it moves on a paid invoice rather than on a form here and the invoices that billed it are its own past.

## 2026-10-23

- A way back up the invoice archive: the window in front of this one is read through the gateway's own backward cursor, so paging past the month you were looking for is one step back rather than a return to the newest and a walk down the whole archive again — the port gains `endingBefore` beside `startingAfter` and `hasNewer` beside `hasMore`, because a window reached from below looks like any other and only the gateway knows whether anything sits in front of it; the fake holds the archive so a backward window is a slice, while Stripe answers `ending_before` with the rows in front of the cursor and says nothing about what is above them — `has_more` looks the way the list is being read — so that read asks for one row more than it will show and the extra row is the answer, an adapter that guessed instead offering a link in front of the newest invoices onto a window with nothing in it; something older always exists on a backward read, because the cursor names an invoice sitting behind what came back; the backward cursor is the gateway's first row rather than the first row shown, the mirror of the forward one, since the draft the page never draws is still the newest row of the window in the gateway's sequence; and a url carrying both cursors is settled on the page rather than at Stripe, which refuses a call that pages two ways at once, because no link here writes one and losing the list over a hand-typed parameter is worse than ignoring it.

## 2026-10-17

- A threshold the customer picks: the line below the cap a warning goes out at becomes a whole percent on the workspace, set on its own section of the account page and read with the cap in one row, with the default kept for every workspace that never picks one — four fifths was a constant in `domain/cap-warning.ts`, and it is the wrong distance for two customers at once, since one that can absorb a pause wants to hear late and one that cannot wants the room to raise its ceiling before anything stops; it is a percentage of the cap rather than a number of units so it keeps its distance when the cap moves, and a whole percent rather than a fraction so the figure stored is the figure typed instead of the nearest double to a quotient; null is the absence of an answer rather than a line at nothing, which is what every row from before the column carries and what an emptied field asks for again, and the bounds are 1 and 99 because a line at nothing fires on the first unit past the quota — which a cap of zero already says — and a line at a hundred lands on the unit that is already being refused, the one moment the mail exists to beat; the ceiling and the line are read together by the request in front of a billable call, so the rule stays pure and the calls nowhere near a warning cost no second query, and the setting has its own route because the two are written at different moments and a body carrying both would make each save a statement about the other.

## 2026-10-15

- The history of who could do what: every role a workspace hands out is recorded with who granted it and when, listed on the transactions page beside the replay audit — a role is a column and setting it overwrites the one before, so a workspace could say who may do what today but not when somebody became an admin or who made them one, which is the question asked after the change nobody meant to make; the grant is written in the same transaction as the membership it describes, by the invite path and the role-change path alike, so there is no window in which somebody holds a role nobody is recorded as giving them and a refused demotion leaves nothing behind; the actor comes off the session rather than the body, like the tenant, because a row whose grantor the caller could name is worth nothing; a write that leaves the role as it was records nothing, which is what makes the date beside a role the date it was given rather than the date it was last confirmed; and the rows have no relation to the account they name, because a workspace asking who made somebody an admin is usually asking about somebody who has since left.

## 2026-10-12

- A real model call behind the gates: an `IAssistantProvider` port whose only vendor-aware file is the model's adapter, a deterministic fake the end-to-end suite and CI run on, and the metered unit given back when a call produces no message — the route returned a template because the entitlement, quota and cap in front of it were the part that had to be right first, and a model behind them turns the counter those gates are decided from into a figure that can be wrong in the customer's disfavour; it cannot be incremented after the call, since a quota read before its own increment is one two concurrent calls both pass, so the unit is counted on the way in and given back on the way out, conditionally on the row holding it because the overage job bills the month from that counter and a negative figure would discount an invoice rather than leave one message off it; a refusal and a reply carrying no text are both declines rather than failures, since each arrives as a perfectly successful response with no answer in it, and the tokens a decline cost are ours to eat rather than a line on a bill the customer cannot reconcile against anything they were shown.

## 2026-10-11

- A picker for a user who belongs to several workspaces: the account and transactions pages act on `ambiguous` with a list of the workspaces the session grants, and the one chosen is remembered so the pages and routes that follow resolve to it — an address invited while it already had a workspace of its own has held two memberships since invites landed, and the rule that refuses to guess between them left every page printing a sentence saying so and drawing nothing, with `x-tenant-id` no help to a reader because a navigation sets no headers; the choice is a cookie rather than a column because it belongs to one browser and not to the account, and it is read as a memory rather than a claim, so a workspace the account has since been removed from is forgotten and leaves the picker instead of a 403 with nothing to click, while `SameSite=Lax` keeps another site from using it to pick which of somebody's workspaces a forged request lands on.
- Roles: an admin may change the workspace — its plan, seats, cap, notice language, credentials and who else is in it — while a member may read all of it and change none, because invites left the seat accounting and the membership rows in place with nothing saying what each of those people may do, so any member could reprice the subscription, mint a credential or remove whoever set the workspace up; the division is whole rather than a ladder of roles, since every change a workspace can have done to it costs the people sharing the bill money or access and a third role would be a promise that one of them is the safe one to hand out; leaving stays the one change a member may make, because somebody invited into a workspace they no longer work with should not have to ask the people still in it to let them out; and the last admin can be neither removed nor demoted, since a workspace of members can be signed in to and read and still cannot be cancelled, repriced or re-staffed by anybody in it, which is the last-member wreck one step in.
- Invites: a workspace offers a seat to an address and the invite holds it until that address signs in, it is withdrawn or it expires, with a member removable to free one — a membership was only ever provisioned for the address that signed in, so a workspace paying for seats had no way to put anybody in them; the invite is addressed rather than bearer because sign-in here is a magic link and the mailbox is already the credential, so there is no token to forward and signing in at the invited address is the whole of accepting; an open invite counts against the seats bought, which is what makes the ceiling on an invite and the floor under a seat reduction read one figure instead of letting a workspace sell back the seat it had just offered somebody; and a send that fails takes the row back, because here the row is the seat rather than a claim on a mail, and an invite nobody received would hold one for a fortnight on behalf of a person who never heard about it.

## 2026-10-10

- The whole invoice archive: the account page pages back through the gateway's own cursor, so a customer can read behind the first twelve invoices without being sent to the portal for them — twelve is as far back as all but a few customers ever read, but the few who need last year's invoice were being told to go and find it in a second place that lists the same documents; the cursor has to be the gateway's rather than the keyset the transaction lists use, because an invoice is in no table here and an archive can only be paged from a position its owner recognises, and it has to name the last row the gateway listed rather than the last row shown, since the draft dropped from the history is still a position in that sequence and continuing from the newest invoice drawn would hand the draft back at the head of every window after it.

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
