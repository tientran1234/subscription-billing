import { describe, expect, it } from "vitest";
import { UNCAPPED } from "@/domain/spend-cap";
import {
  DEFAULT_CAP_WARNING_PCT,
  MAX_CAP_WARNING_PCT,
  MIN_CAP_WARNING_PCT,
  capWarningFor,
  capWarningPct,
  capWarningThreshold,
  checkCapWarningAt,
} from "@/domain/cap-warning";
import { renderCapWarningEmail } from "@/emails/render";

describe("the line a cap warning is earned at", () => {
  it("sits four fifths of the way up the ceiling by default", () => {
    expect(capWarningThreshold(500)).toBe((500 * DEFAULT_CAP_WARNING_PCT) / 100);
    expect(capWarningThreshold(20_000)).toBe(16_000);
  });

  it("rounds up, so a small cap is not warned about at the first unit", () => {
    // Four fifths of three is 2.4 units, and there is no such thing as two and
    // a bit messages: rounding down would write to a customer who has used one.
    expect(capWarningThreshold(3)).toBe(3);
  });

  // The guarantee the item exists for: the distance between the warning and
  // the refusal is the customer's to set, and the figure they typed is the
  // figure the line is computed from.
  it("sits where the workspace asked, when it has asked", () => {
    expect(capWarningThreshold(500, 50)).toBe(250);
    expect(capWarningThreshold(500, 90)).toBe(450);
    expect(capWarningThreshold(1_000, 99)).toBe(990);
  });

  it("falls back to the default for a workspace that never picked one", () => {
    expect(capWarningThreshold(500, null)).toBe(capWarningThreshold(500));
    expect(capWarningPct(null)).toBe(DEFAULT_CAP_WARNING_PCT);
    expect(capWarningPct(25)).toBe(25);
  });

  it("rounds a chosen line up too", () => {
    // A tenth of 25 is 2.5 units; the line is the first whole unit at or past
    // it, so a customer asking for a tenth is not warned at two.
    expect(capWarningThreshold(25, 10)).toBe(3);
  });
});

describe("which lines a workspace may ask for", () => {
  it("takes a whole percent inside the bounds, and null for the default", () => {
    expect(checkCapWarningAt(null)).toBeNull();
    expect(checkCapWarningAt(MIN_CAP_WARNING_PCT)).toBeNull();
    expect(checkCapWarningAt(MAX_CAP_WARNING_PCT)).toBeNull();
    expect(checkCapWarningAt(50)).toBeNull();
  });

  it("refuses a line that would warn at nothing or at the refusal itself", () => {
    // Zero warns on the first unit past the quota, which is what a cap of zero
    // already says; a hundred lands the warning on the unit being refused, so
    // the mail that exists to arrive in time never would.
    expect(checkCapWarningAt(0)).toBe("invalid_warning_at");
    expect(checkCapWarningAt(100)).toBe("invalid_warning_at");
    expect(checkCapWarningAt(-10)).toBe("invalid_warning_at");
  });

  it("refuses a part of a percent", () => {
    expect(checkCapWarningAt(80.5)).toBe("invalid_warning_at");
    expect(checkCapWarningAt(Number.NaN)).toBe("invalid_warning_at");
  });
});

describe("which warning a month has earned", () => {
  it("stays quiet while the month is well inside its ceiling", () => {
    expect(capWarningFor(100, 500)).toBeNull();
    expect(capWarningFor(399, 500)).toBeNull();
  });

  it("warns on the unit that crosses the line, and not before it", () => {
    expect(capWarningFor(399, 500)).toBeNull();
    expect(capWarningFor(400, 500)).toBe("approaching");
    expect(capWarningFor(500, 500)).toBe("approaching");
  });

  // The guarantee the item exists for: the mail about a refusal is sent at the
  // refusal, by the same rule that decides it, rather than left for the job
  // that bills the month a fortnight later.
  it("says the ceiling was reached for the first unit past it", () => {
    expect(capWarningFor(501, 500)).toBe("reached");
    expect(capWarningFor(9_000, 500)).toBe("reached");
  });

  it("stays quiet for a workspace that set no ceiling", () => {
    // Nothing to approach, and nothing that will be refused: an uncapped
    // workspace is billed for whatever the month runs to, which is what it
    // asked for.
    expect(capWarningFor(1, UNCAPPED)).toBeNull();
    expect(capWarningFor(1_000_000_000, UNCAPPED)).toBeNull();
  });

  it("stays quiet about a month that has not gone past its quota", () => {
    // A cap is about the add-on, and nothing has been added on yet: every unit
    // up to the quota was paid for by the plan, cap or no cap.
    expect(capWarningFor(0, 500)).toBeNull();
    expect(capWarningFor(0, 0)).toBeNull();
  });

  it("goes straight to reached under a cap of zero, which has no approach", () => {
    // The customer asked for their quota to be a ceiling again, so the first
    // unit past it is both the first refusal and the only news there is.
    expect(capWarningFor(1, 0)).toBe("reached");
  });

  it("warns where the workspace asked rather than at four fifths", () => {
    // Half of 500 is the line this workspace set, so 250 is news and 399 — a
    // unit the default would still be silent about — is not news twice.
    expect(capWarningFor(249, 500, 50)).toBeNull();
    expect(capWarningFor(250, 500, 50)).toBe("approaching");
    expect(capWarningFor(399, 500, 50)).toBe("approaching");
  });

  it("still refuses before it warns, whatever line was asked for", () => {
    // A line is about the approach. Past the ceiling the news is the refusal,
    // so a workspace that asked to hear late does not hear "approaching" about
    // a month that has already stopped.
    expect(capWarningFor(501, 500, 99)).toBe("reached");
  });

  it("stays quiet under a chosen line for a workspace with no ceiling", () => {
    expect(capWarningFor(1_000, UNCAPPED, 10)).toBeNull();
  });
});

const props = {
  locale: "en" as const,
  tenantName: "Acme",
  planName: "Pro",
  units: 410,
  cap: 500,
  accountUrl: "https://billing.example.test/en/account",
};

describe("cap warning templates", () => {
  it("tells a customer coming up to the ceiling both figures and where it is set", async () => {
    // A warning that says only "nearly" leaves the reader to go and look up the
    // number it was talking about.
    const mail = await renderCapWarningEmail("approaching", props);

    expect(mail.subject).toBe("You are close to your spend cap");
    expect(mail.html).toContain("410");
    expect(mail.html).toContain("500");
    expect(mail.html).toContain(props.accountUrl);
    expect(mail.html).toContain("Pro");
  });

  it("does not tell a customer who is still being served that anything stopped", async () => {
    const mail = await renderCapWarningEmail("approaching", props);
    expect(mail.text).toContain("Nothing has stopped");
  });

  it("points at the account page, not at the gateway's portal", async () => {
    // The portal has never been told the cap exists and could not change it.
    for (const kind of ["approaching", "reached"] as const) {
      const mail = await renderCapWarningEmail(kind, props);
      expect(mail.html).toContain(props.accountUrl);
      expect(mail.html).not.toContain("portal");
    }
  });

  it("quotes the cap and not the counter once the ceiling is reached", async () => {
    // The call is metered before it is refused, so the counter is above the
    // ceiling by now and only the ceiling will ever be billed: the larger
    // figure appears on no invoice and would only raise a question.
    const mail = await renderCapWarningEmail("reached", { ...props, units: 512 });

    expect(mail.subject).toBe("Your spend cap has paused further usage");
    expect(mail.html).toContain("500");
    expect(mail.html).not.toContain("512");
  });

  it("renders a plain-text part from the same tree, so the two cannot drift", async () => {
    for (const kind of ["approaching", "reached"] as const) {
      const mail = await renderCapWarningEmail(kind, props);

      expect(mail.text).toContain(props.accountUrl);
      expect(mail.text).toContain("Acme");
      expect(mail.text).not.toContain("<p");
    }
  });

  it("keeps the preheader out of the plain-text part", async () => {
    const mail = await renderCapWarningEmail("reached", props);

    expect(mail.html).toContain("Calls past your Pro allowance are being refused");
    expect(mail.text).not.toContain("Calls past your Pro allowance are being refused");
  });
});

describe("the language a cap warning is written in", () => {
  const vi = { ...props, locale: "vi" as const, accountUrl: "https://billing.example.test/vi/account" };

  it("warns a Vietnamese workspace in Vietnamese, with both figures intact", async () => {
    const mail = await renderCapWarningEmail("approaching", vi);

    expect(mail.subject).toBe("Bạn đã gần đạt giới hạn chi tiêu");
    expect(mail.html).toContain("410");
    expect(mail.html).toContain("500");
    expect(mail.html).toContain('lang="vi"');
  });

  it("still quotes the cap and not the counter, in either language", async () => {
    // The rule about which figure a reached warning names is about the invoice,
    // not about English: a translation that reached for `units` because the
    // sentence read better would promise a number no invoice carries.
    const mail = await renderCapWarningEmail("reached", { ...vi, units: 512 });

    expect(mail.html).toContain("500");
    expect(mail.html).not.toContain("512");
  });

  it("keeps the subject in the same language as the body", async () => {
    for (const kind of ["approaching", "reached"] as const) {
      const [english, vietnamese] = await Promise.all([
        renderCapWarningEmail(kind, props),
        renderCapWarningEmail(kind, vi),
      ]);

      expect(vietnamese.subject).not.toBe(english.subject);
      expect(vietnamese.html).not.toBe(english.html);
    }
  });

  it("links a reader into the pages of the language they are written in", async () => {
    const mail = await renderCapWarningEmail("reached", vi);

    expect(mail.html).toContain("https://billing.example.test/vi/account");
    expect(mail.html).not.toContain("/en/");
  });
});
