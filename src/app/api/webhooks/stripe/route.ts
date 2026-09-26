import { WebhookVerificationError } from "@/domain/billing-event";
import { StripeProvider } from "@/providers/stripe";
import { applyEvent } from "@/server/billing.service";
import { notifyDunning } from "@/server/dunning";
import { env } from "@/lib/env";

// The Stripe SDK verifies signatures with node:crypto — not available on edge.
export const runtime = "nodejs";

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature") ?? "";

  // RAW body. Stripe signs the exact bytes it sent; request.json() would
  // re-serialize them and every signature check would fail.
  const rawBody = await request.text();

  const e = env();
  const provider = new StripeProvider(e.STRIPE_SECRET_KEY, e.STRIPE_WEBHOOK_SECRET);

  let event;
  try {
    event = await provider.verifyWebhook(rawBody, signature);
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return Response.json({ error: "invalid signature" }, { status: 400 });
    }
    throw err;
  }

  const outcome = await applyEvent(provider.name, event);

  // After the transition, never instead of it: the customer is told about a
  // status their subscription actually reached, and a mail server that is
  // down cannot undo or redeliver the status change itself.
  const notified = await notifyDunning({ event, outcome, appUrl: e.APP_URL });

  // Always 200 once the signature is valid. A non-2xx makes Stripe retry, and
  // every outcome here is already final — retrying would change nothing.
  return Response.json({ received: true, outcome, notified });
}
