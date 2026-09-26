/**
 * How a message leaves the process.
 *
 * An interface for the same reason `IBillingProvider` is one: the guarantees
 * worth testing here are about which mail is composed and how often, not about
 * SMTP, and a test that needs a mail server to prove "exactly once" is a test
 * nobody runs.
 */
import { createTransport, type Transporter } from "nodemailer";
import { mailEnv } from "@/lib/env";

export interface OutboundEmail {
  to: string;
  subject: string;
  html: string;
  /** Always sent alongside the HTML; clients that cannot render it still read.  */
  text: string;
}

export interface Mailer {
  send(message: OutboundEmail): Promise<void>;
}

// One pool for the process. Built on the first send rather than at import, so
// `next build` and every request that never mails anything stay clear of the
// SMTP settings.
let transport: Transporter | null = null;

export function smtpMailer(): Mailer {
  return {
    async send(message) {
      const e = mailEnv();
      transport ??= createTransport(e.EMAIL_SERVER);
      await transport.sendMail({ from: e.EMAIL_FROM, ...message });
    },
  };
}

/**
 * Keeps what it was given instead of sending it. Used by the tests, and it is
 * what lets the whole webhook path run locally with no mail server.
 */
export class MemoryMailer implements Mailer {
  readonly sent: OutboundEmail[] = [];

  async send(message: OutboundEmail): Promise<void> {
    this.sent.push(message);
  }
}
