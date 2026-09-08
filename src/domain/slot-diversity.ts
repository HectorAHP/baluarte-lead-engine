import { localDateString } from "./timezone.js";

/**
 * Fase 7K -- "Sandler Booking Flow + Weekly Slot Diversity" (spec section 6).
 *
 * Product problem: without this, `computeAvailableSlots` simply sorted every candidate slot
 * chronologically and truncated to `maxSlots` -- which meant Lia almost always offered the first
 * `maxSlots` times of the SAME earliest available day (e.g. three Tuesday times) instead of
 * spreading options across the week. This pure helper re-selects from an already
 * business-hours-filtered, already busy-period-filtered, already date-preference-filtered,
 * already-sorted candidate list to prefer variety of LOCAL calendar date over raw chronological
 * proximity, without ever pulling in a slot that wasn't already valid.
 *
 * Algorithm (spec section 6, verbatim rule order):
 *  1. Only ever chooses among slots already in `slots` -- never invents or re-validates one.
 *  2. Input is assumed already in chronological order (computeAvailableSlots sorts before calling
 *     this) and the output preserves that chronological order -- diversity changes WHICH slots are
 *     kept, never their relative order.
 *  3. First pass: at most one slot per distinct LOCAL calendar date (in `timezone`), taken in
 *     chronological order, until `maxSlots` distinct dates have contributed one slot each, or the
 *     input is exhausted.
 *  4. If fewer distinct dates exist than `maxSlots` (so the first pass produced fewer than
 *     `maxSlots` results), fill the remaining budget with the next chronological slots that
 *     weren't already picked -- so a genuinely slow week (e.g. only two available days) still
 *     returns as many options as exist, up to `maxSlots`, rather than artificially withholding
 *     a second same-day slot.
 *
 * Deliberately generic over any `{ start: Date }`-shaped slot (not tied to `Slot`/`OfferedSlot`
 * specifically) so it can be unit-tested and reused without an import cycle.
 */
export function selectDiverseSlots<T extends { start: Date }>(
  slots: readonly T[],
  maxSlots: number,
  timezone: string,
): T[] {
  if (maxSlots <= 0 || slots.length === 0) return [];

  const seenDates = new Set<string>();
  const firstPass: T[] = [];
  const skipped: T[] = [];

  for (const slot of slots) {
    if (firstPass.length >= maxSlots) {
      skipped.push(slot);
      continue;
    }
    const localDate = localDateString(slot.start, timezone);
    if (seenDates.has(localDate)) {
      skipped.push(slot);
      continue;
    }
    seenDates.add(localDate);
    firstPass.push(slot);
  }

  if (firstPass.length >= maxSlots) return firstPass;

  const remainingBudget = maxSlots - firstPass.length;
  const fill = skipped.slice(0, remainingBudget);

  // Merge back into chronological order -- firstPass and fill are each already chronological
  // (both derived from a single forward pass over the sorted input), so a simple sort by start
  // time is enough to interleave them correctly without a manual merge.
  return [...firstPass, ...fill].sort((a, b) => a.start.getTime() - b.start.getTime());
}
