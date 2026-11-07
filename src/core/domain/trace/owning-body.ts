/** A place in a source: a 1-based line and a 0-based column, counted as the parser that placed it counts them. */
export interface SourcePosition {
  line: number;
  column: number;
}

/** The span of a declaration, its end exclusive. */
export interface SourceSpan {
  start: SourcePosition;
  end: SourcePosition;
}

function compare(a: SourcePosition, b: SourcePosition): number {
  return a.line - b.line || a.column - b.column;
}

/** Whether `at` lies inside `span`, from its start up to, and not including, its end. */
export function containsPosition(span: SourceSpan, at: SourcePosition): boolean {
  return compare(span.start, at) <= 0 && compare(at, span.end) < 0;
}

/**
 * The body a place belongs to: the innermost of `bodies` whose span contains it, so a place inside a nested declaration
 * belongs to that declaration and never to one around it or beside it. Declarations nest, so the innermost is the one
 * that starts last, and of two that start together the one that ends first.
 */
export function owningBody<T extends SourceSpan>(bodies: readonly T[], at: SourcePosition): T | undefined {
  let owner: T | undefined;
  for (const body of bodies) {
    if (!containsPosition(body, at)) continue;
    if (owner === undefined || compare(body.start, owner.start) > 0 || (compare(body.start, owner.start) === 0 && compare(body.end, owner.end) < 0)) owner = body;
  }
  return owner;
}
