/** Source coordinates: lines are 1-based, columns are 0-based; the end is exclusive. */
export interface SourceSpan {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export function containsPosition(span: SourceSpan, line: number, column: number): boolean {
  return (line > span.startLine || (line === span.startLine && column >= span.startColumn)) &&
    (line < span.endLine || (line === span.endLine && column < span.endColumn));
}

/** The unique innermost body containing the point. Equal or overlapping innermost spans prove no owner. */
export function owningBodyAt<T extends SourceSpan>(bodies: readonly T[], line: number, column: number): T | undefined {
  const found = bodies.filter((body) => containsPosition(body, line, column));
  const inner = found.filter((body) => !found.some((other) => other !== body &&
    containsPosition(body, other.startLine, other.startColumn) &&
    (other.startLine !== body.startLine || other.startColumn !== body.startColumn || other.endLine !== body.endLine || other.endColumn !== body.endColumn) &&
    (other.endLine < body.endLine || (other.endLine === body.endLine && other.endColumn <= body.endColumn))));
  return inner.length === 1 ? inner[0] : undefined;
}
