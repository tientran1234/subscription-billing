/**
 * How many seats a subscription may be bought with, and the floor a change may
 * not cross.
 *
 * Pure — no I/O — like the rest of this directory, so the one rule about seats
 * runs in the picker, at checkout and on a plan change alike rather than being
 * written three times.
 *
 * The floor is the half worth naming. A seat is a `quantity` on the price, so
 * dropping one is an ordinary reprice as far as the gateway is concerned: it
 * credits the unused time and moves on. Here it is not, because a seat that is
 * occupied is a person, and the reduction that pays for itself takes somebody's
 * access away without ever saying whose. So the count in use is a floor and the
 * refusal comes before anything is quoted — whoever is leaving is removed
 * first, and then the seat they left can be sold back.
 */

export const MIN_SEATS = 1;

/**
 * An upper bound, so a slip in a number field cannot ask the gateway to invoice
 * for ten thousand seats. A workspace genuinely larger than this is a sales
 * conversation rather than a self-service checkout.
 */
export const MAX_SEATS = 500;

export type SeatRefusal =
  /** Not a whole number of seats, or more than we sell without talking first. */
  | "invalid_seats"
  /** Fewer seats than there are people holding one. */
  | "seats_in_use";

/**
 * A seat count we are able to sell — the bounds on their own, without the
 * occupancy floor.
 *
 * Separate from {@link checkSeats} because reading a count back off a paid
 * invoice asks only this: the money has been taken, so the seats are bought
 * whether or not they are all occupied, and refusing them there would leave the
 * tenant short of what they paid for.
 */
export function isSellableSeatCount(seats: number): boolean {
  return Number.isInteger(seats) && seats >= MIN_SEATS && seats <= MAX_SEATS;
}

/**
 * Whether a subscription may be bought or repriced at `seats`, given how many
 * are occupied right now. `null` means it may.
 */
export function checkSeats(seats: number, inUse: number): SeatRefusal | null {
  if (!isSellableSeatCount(seats)) return "invalid_seats";
  if (seats < inUse) return "seats_in_use";
  return null;
}
