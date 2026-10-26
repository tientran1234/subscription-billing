import { describe, expect, it } from "vitest";
import {
  SETTING_HISTORY_WINDOW,
  TRACKED_SETTINGS,
  isSettingChange,
  isTrackedSetting,
  settingValueOf,
} from "@/domain/setting-history";

describe("which writes moved a setting", () => {
  it("counts the first value a workspace sets", () => {
    // Nothing to replace: every workspace starts with all three unset, so the
    // first save is the change that says who chose it.
    expect(isSettingChange(null, "500")).toBe(true);
    expect(isSettingChange(null, "vi")).toBe(true);
  });

  it("counts a figure moved either way", () => {
    expect(isSettingChange("100", "500")).toBe(true);
    expect(isSettingChange("500", "100")).toBe(true);
  });

  it("counts a setting cleared back to its default", () => {
    // The cap lifted and the warning line put back are things a workspace
    // chose, so each is a row: null is a value here, not a missing one.
    expect(isSettingChange("500", null)).toBe(true);
  });

  it("does not count a write that leaves the setting as it was", () => {
    // The account page posts whatever is in the box, so a reader who saves
    // without touching anything arrives here. A row for one would make the
    // date beside a figure the date it was last confirmed.
    expect(isSettingChange("500", "500")).toBe(false);
    expect(isSettingChange(null, null)).toBe(false);
  });
});

describe("a setting's value, as the table holds it", () => {
  it("keeps a figure as the digits that were typed", () => {
    expect(settingValueOf(500)).toBe("500");
    // Zero is a ceiling a workspace may set — it is not nothing.
    expect(settingValueOf(0)).toBe("0");
  });

  it("keeps a language as it stands", () => {
    expect(settingValueOf("vi")).toBe("vi");
  });

  it("keeps unset apart from the figure zero", () => {
    expect(settingValueOf(null)).toBeNull();
    // The one pair that would collapse if null were stored as text: a cap of
    // zero refuses every unit past the quota, an unset cap refuses none.
    expect(isSettingChange(settingValueOf(null), settingValueOf(0))).toBe(true);
  });
});

describe("the settings that are tracked", () => {
  it("are the three a workspace sets on itself", () => {
    // The plan is deliberately absent: it moves on the gateway's paid invoice,
    // and what it used to be is on the invoices that billed it.
    expect([...TRACKED_SETTINGS]).toEqual(["spend_cap", "cap_warning_pct", "notice_locale"]);
  });

  it("are recognised by name, and nothing else is", () => {
    for (const setting of TRACKED_SETTINGS) expect(isTrackedSetting(setting)).toBe(true);
    expect(isTrackedSetting("plan_key")).toBe(false);
    expect(isTrackedSetting("")).toBe(false);
  });
});

describe("the window", () => {
  it("is a bound the page can draw", () => {
    expect(SETTING_HISTORY_WINDOW).toBeGreaterThan(0);
    expect(Number.isInteger(SETTING_HISTORY_WINDOW)).toBe(true);
  });
});
