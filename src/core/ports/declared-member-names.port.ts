import type { SourceFile } from "./entrypoint-extractor.port.ts";

/** The member names one source declares where a value can live, and its callable declarations, read from its syntax. */
export interface DeclaredMemberNames {
  /** Sorted, once each. */
  names: readonly string[];
  /**
   * The fields, properties, variables and constants a function value is written to: a lambda, a method reference, an
   * arrow or a function expression, as an initializer or an assignment. Sorted, once each.
   */
  functionValues: readonly string[];
  /** In source order. */
  callables: readonly DeclaredCallable[];
}

/** A method or function declaration as its syntax states it: whether it has a body, and whether a subtype can override it. */
export interface DeclaredCallable {
  name: string;
  /** The line of its first token, an annotation or a decorator included. */
  start: number;
  /** The line of its name; an index node of the declaration starts between `start` and this line. */
  nameLine: number;
  /** Abstract methods, interface methods without a body, overload signatures and ambient functions have none. */
  body: boolean;
  /** Neither static, private nor final, nor a function outside a type. */
  overridable: boolean;
}

/**
 * Reads, with a language's own parser, the member names a source declares in value positions: object-literal keys at any
 * depth and in any context, assigned properties, and the members of classes, records, enums and anonymous classes; never
 * a name only a type declares. From the same parse it reads the source's callable declarations. Declared by its
 * consumer, `core/application/trace`: a member call whose name the index holds no node for runs repository code when a
 * source declares that name, so it is a cut, never an external call (RFC-0013 R6); and whether a reached method has a
 * body or can be overridden decides its dispatch cut (R10), which the index does not record.
 */
export interface DeclaredMemberNamesReader {
  /** A source of a language the reader does not parse, or one the parser rejects, declares none. */
  memberNames(file: SourceFile): Promise<DeclaredMemberNames>;
}
