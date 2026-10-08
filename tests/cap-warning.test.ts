import { describe, expect, it } from "vitest";
import { UNCAPPED } from "@/domain/spend-cap";
import { CAP_WARNING_AT, capWarningFor, capWarningThreshold } from "@/domain/cap-warning";

describe("the line a cap warning is earned at", () => {
  it("sits four fifths of the way up the ceiling", () => {
    expect(capWarningThreshold(500)).toBe(500 * CAP_WARNING_AT);
    expect(capWarningThreshold(20_000)).toBe(16_000);
  });

  it("rounds up, so a small cap is not warned about at the first unit", () => {
    // Four fifths of three is 2.4 units, and there is no such thing as two and
    // a bit messages: rounding down would write to a customer who has used one.
    expect(capWarningThreshold(3)).toBe(3);
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
});
