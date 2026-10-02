import { describe, expect, it } from "vitest";
import { MAX_SEATS, MIN_SEATS, checkSeats, isSellableSeatCount } from "@/domain/seats";

describe("seat counts we can sell", () => {
  it("sells whole numbers from one up to the bound", () => {
    expect(isSellableSeatCount(MIN_SEATS)).toBe(true);
    expect(isSellableSeatCount(25)).toBe(true);
    expect(isSellableSeatCount(MAX_SEATS)).toBe(true);
  });

  it("refuses anything that is not a count of people", () => {
    for (const seats of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isSellableSeatCount(seats)).toBe(false);
    }
  });

  // A slip in a number field should not become an invoice for ten thousand
  // seats. Above the bound is a sales conversation, not a self-service price.
  it("refuses a count past the bound", () => {
    expect(isSellableSeatCount(MAX_SEATS + 1)).toBe(false);
  });
});

describe("the floor seats in use put under a change", () => {
  it("allows buying more seats than are occupied, and exactly as many", () => {
    expect(checkSeats(5, 3)).toBeNull();
    expect(checkSeats(3, 3)).toBeNull();
  });

  // The guarantee: a reduction that pays for itself by taking somebody's access
  // away, without ever saying whose, is refused before anything is quoted.
  it("refuses dropping below the seats that are occupied", () => {
    expect(checkSeats(2, 3)).toBe("seats_in_use");
    expect(checkSeats(MIN_SEATS, 2)).toBe("seats_in_use");
  });

  it("reports an unsellable count as that rather than as an occupancy problem", () => {
    expect(checkSeats(0, 1)).toBe("invalid_seats");
    expect(checkSeats(2.5, 1)).toBe("invalid_seats");
    expect(checkSeats(MAX_SEATS + 1, 1)).toBe("invalid_seats");
  });
});
