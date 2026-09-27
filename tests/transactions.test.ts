import { describe, expect, it } from "vitest";
import {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  decodeCursor,
  encodeCursor,
  isOlderThanCursor,
  pageOf,
  parseKeyState,
  parsePageSize,
  parsePeriod,
  parseSubscriptionFilter,
  shiftPeriod,
} from "@/domain/transactions";

const row = (id: string, iso: string) => ({ id, createdAt: new Date(iso) });

describe("cursor codec", () => {
  it("round-trips the instant to the millisecond and the id unchanged", () => {
    const original = row("ckz9", "2026-09-25T12:34:56.789Z");
    expect(decodeCursor(encodeCursor(original))).toEqual(original);
  });

  it("refuses anything it did not write", () => {
    for (const bad of [null, undefined, "", "not-a-cursor", encodeCursor(row("", "2026-01-01"))]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });

  it("refuses a cursor carrying an id but no readable instant", () => {
    const forged = Buffer.from("yesterday|ckz9").toString("base64url");
    expect(decodeCursor(forged)).toBeNull();
  });
});

describe("cursor ordering", () => {
  const cursor = row("b", "2026-09-25T12:00:00.000Z");

  it("puts older rows on the far side and newer rows on the near side", () => {
    expect(isOlderThanCursor(row("z", "2026-09-24T12:00:00.000Z"), cursor)).toBe(true);
    expect(isOlderThanCursor(row("a", "2026-09-26T12:00:00.000Z"), cursor)).toBe(false);
  });

  // The reason the cursor is a pair. On the instant alone, both of these sit
  // exactly on the boundary: one of them is served twice or not at all.
  it("separates two rows written in the same millisecond", () => {
    expect(isOlderThanCursor(row("a", "2026-09-25T12:00:00.000Z"), cursor)).toBe(true);
    expect(isOlderThanCursor(row("c", "2026-09-25T12:00:00.000Z"), cursor)).toBe(false);
  });

  it("never puts the cursor's own row on the far side of itself", () => {
    expect(isOlderThanCursor(cursor, cursor)).toBe(false);
  });
});

describe("page assembly", () => {
  const fetched = [
    row("e", "2026-09-05"),
    row("d", "2026-09-04"),
    row("c", "2026-09-03"),
  ];

  it("returns the page without the row fetched only to prove there is a next one", () => {
    const page = pageOf(fetched, 2);
    expect(page.items.map((r) => r.id)).toEqual(["e", "d"]);
  });

  it("points the cursor at the last row returned, not at the one withheld", () => {
    // Pointing it at "c" would hand out a second page starting below "c", and
    // "c" — a row nobody has seen — would be skipped.
    expect(decodeCursor(pageOf(fetched, 2).nextCursor)).toEqual(row("d", "2026-09-04"));
  });

  it("has no next cursor once the fetch came back short", () => {
    expect(pageOf(fetched, 3).nextCursor).toBeNull();
    expect(pageOf(fetched, 10).nextCursor).toBeNull();
    expect(pageOf([], 10)).toEqual({ items: [], nextCursor: null });
  });
});

describe("paging a list that is still being written to", () => {
  /** What the query layer does, in memory: newest first, everything past the cursor. */
  const query = (rows: readonly ReturnType<typeof row>[], after: string | null, limit: number) => {
    const cursor = decodeCursor(after);
    const visible = cursor ? rows.filter((r) => isOlderThanCursor(r, cursor)) : [...rows];
    visible.sort((a, b) =>
      a.createdAt.getTime() === b.createdAt.getTime()
        ? b.id.localeCompare(a.id)
        : b.createdAt.getTime() - a.createdAt.getTime(),
    );
    return pageOf(visible.slice(0, limit + 1), limit);
  };

  it("serves every row exactly once even though the head keeps moving", () => {
    const rows = [
      row("s4", "2026-09-04T00:00:00.000Z"),
      row("s3", "2026-09-03T00:00:00.000Z"),
      row("s2", "2026-09-02T00:00:00.000Z"),
      row("s1", "2026-09-01T00:00:00.000Z"),
    ];

    const first = query(rows, null, 2);
    expect(first.items.map((r) => r.id)).toEqual(["s4", "s3"]);

    // Two checkouts land while the admin is reading page one. Under OFFSET 2
    // the boundary would have slid two rows down and page two would repeat
    // "s4" and "s3"; the cursor is anchored to "s3" itself, so it cannot.
    rows.unshift(row("s6", "2026-09-06T00:00:00.000Z"), row("s5", "2026-09-05T00:00:00.000Z"));

    const second = query(rows, first.nextCursor, 2);
    expect(second.items.map((r) => r.id)).toEqual(["s2", "s1"]);
    expect(second.nextCursor).toBeNull();

    const seen = [...first.items, ...second.items].map((r) => r.id);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("page size", () => {
  it("falls back to the default for anything that is not a row count", () => {
    for (const bad of [null, undefined, "", "0", "-5", "2.5", "all"]) {
      expect(parsePageSize(bad)).toBe(PAGE_SIZE_DEFAULT);
    }
  });

  it("honours a sensible request and caps an unbounded one", () => {
    expect(parsePageSize("5")).toBe(5);
    expect(parsePageSize(String(PAGE_SIZE_MAX + 1))).toBe(PAGE_SIZE_MAX);
    expect(parsePageSize("1000000")).toBe(PAGE_SIZE_MAX);
  });
});

describe("filters", () => {
  it("keeps the values it recognises", () => {
    expect(parseSubscriptionFilter({ status: "PAST_DUE", planKey: "pro" })).toEqual({
      status: "PAST_DUE",
      planKey: "pro",
    });
    expect(parseKeyState("revoked")).toBe("revoked");
    expect(parsePeriod("2026-01", "2026-09")).toBe("2026-01");
  });

  // A filter narrows a list. One that narrowed to nothing would render the same
  // empty table as a tenant who has never subscribed at all.
  it("drops a value it does not recognise rather than matching nothing", () => {
    expect(parseSubscriptionFilter({ status: "ACTIVEE", planKey: "enterprise" })).toEqual({});
    expect(parseSubscriptionFilter({ status: null, planKey: undefined })).toEqual({});
    expect(parseKeyState("expired")).toBeUndefined();
  });

  it("falls back to the caller's period for a month that cannot exist", () => {
    for (const bad of [null, "2026", "2026-13", "2026-00", "last month"]) {
      expect(parsePeriod(bad, "2026-09")).toBe("2026-09");
    }
  });

  it("steps a month at a time, over the turn of the year", () => {
    expect(shiftPeriod("2026-09", 0)).toBe("2026-09");
    expect(shiftPeriod("2026-01", -1)).toBe("2025-12");
    expect(shiftPeriod("2026-12", 1)).toBe("2027-01");
    // Whatever it produces has to be a period the parser will take back.
    expect(parsePeriod(shiftPeriod("2026-12", 1), "2026-09")).toBe("2027-01");
  });
});
