import { canonicalJson } from "../core/domain/shared/canonical-json.ts";

export function shareExactContext<T, C>(rows: readonly T[], contextOf: (row: T) => C): Readonly<{
  contexts: readonly C[];
  rows: readonly Readonly<{ value: T; contextIndex: number }>[];
}> {
  const contexts: C[] = [];
  const indices = new Map<string, number>();
  const mapped = rows.map(value => {
    const context = contextOf(value);
    const key = canonicalJson(context);
    let contextIndex = indices.get(key);
    if (contextIndex === undefined) {
      contextIndex = contexts.length;
      contexts.push(context);
      indices.set(key, contextIndex);
    }
    return { value, contextIndex };
  });
  return { contexts, rows: mapped };
}

export function preferShorterText(literal: string, shared: string): string {
  return Buffer.byteLength(shared, "utf8") < Buffer.byteLength(literal, "utf8") ? shared : literal;
}

/** Include each line terminator, matching the renderer block comparison contract. */
export function blockBytes(lines: readonly string[]): number {
  return lines.reduce((total, line) => total + Buffer.byteLength(line, "utf8") + 1, 0);
}
