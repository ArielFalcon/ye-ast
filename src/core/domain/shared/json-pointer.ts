/** One RFC 6901 reference token (`~` as `~0`, `/` as `~1`). */
export function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}
