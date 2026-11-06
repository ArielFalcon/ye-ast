import type { SourceFile } from "./entrypoint-extractor.port.ts";

/** The member names one source declares where a value can live, and its callable declarations, read from its syntax. */
export interface DeclaredMemberNames {
  /** Sorted, once each. */
  names: readonly string[];
  /** In source order. */
  functionValueCalls: readonly FunctionValueCall[];
  /** In source order. */
  callables: readonly DeclaredCallable[];
  /** In source order. */
  receiverBindings: readonly ReceiverBinding[];
}

/**
 * A member call `r.m(...)` whose bare receiver `r` the source binds to one kind of value, because every store into the
 * binding (each initializer and each assignment) stores that kind: a literal of a library type, an instance of one
 * class the file names in `new`, or an instance of a class the file declares. A parameter, a destructured or iterated
 * binding, an exported binding, a script's global, a binding a dynamic scope may write, and any other store bind nothing.
 */
export interface ReceiverBinding {
  /** Where the call starts, 1-based. */
  line: number;
  column: number;
  receiver: string;
  member: string;
  holds: ReceiverValue;
}

/**
 * `literal`: a regular expression, array or string literal, an instance of that library type. `constructed`: `new name()`
 * where the file neither declares nor binds `name` except by an import, at the place of the first such `new`, so where
 * the name is rooted decides the class. `declared`: `new name()` of the one class declaration the file binds `name` to, at
 * the line of its name.
 */
export type ReceiverValue =
  | { kind: "literal"; type: "RegExp" | "Array" | "String" }
  | { kind: "constructed"; name: string; line: number; column: number }
  | { kind: "declared"; name: string; line: number };

/**
 * A member call `r.m(...)` or `this.r.m(...)` whose receiver `r` the source binds to a function value: `this.r` to a
 * field of the enclosing class, a bare `r` to its innermost local, parameter or module binding (a Java bare name falls
 * back to the enclosing class's field). The binding holds a function value when a lambda, a method reference, an arrow
 * or a function expression is its initializer or is assigned to it, when it is a function declaration, or when its
 * declared type is a function type.
 */
export interface FunctionValueCall {
  /** The line the call starts on. */
  line: number;
  receiver: string;
  member: string;
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
 * a name only a type declares. From the same parse it reads the source's callable declarations and the member calls
 * whose receiver it binds to a function value. Declared by its consumer, `core/application/trace`: a member call whose
 * name the index holds no node for runs repository code when a source declares that name or the call's receiver holds
 * a function value, so it is a cut, never an external call (RFC-0013 R6); and whether a reached method has a body or
 * can be overridden decides its dispatch cut (R10), which the index does not record.
 */
export interface DeclaredMemberNamesReader {
  /** A source of a language the reader does not parse, or one the parser rejects, declares none. */
  memberNames(file: SourceFile): Promise<DeclaredMemberNames>;
}
