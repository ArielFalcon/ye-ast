/** A count a request may carry: a positive safe integer, which is what every bound and deadline means. */
export function isPositiveCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
