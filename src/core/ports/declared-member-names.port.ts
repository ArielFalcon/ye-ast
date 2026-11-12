import type { DerivedFacts } from "./derived-facts.port.ts";
import type { SourceFile } from "./entrypoint-extractor.port.ts";
import type { SourceSpan } from "../domain/shared/owning-body.ts";

/** The member names one source declares where a value can live, and its callable declarations, read from its syntax. */
export interface DeclaredMemberNames {
  /**
   * Every syntactic call or construction, at its callee start (1-based UTF-16). Absent when no reader parsed the source:
   * its calls are unknown, never none (ADR-0041 decision 2).
   */
  calls?: readonly SyntaxCall[];
  initializedFields?: readonly Pick<DeclaredCallable, "name" | "start" | "nameLine">[];
  /** Sorted, once each. */
  names: readonly string[];
  /** In source order. */
  functionValueCalls: readonly FunctionValueCall[];
  /** In source order. */
  callables: readonly DeclaredCallable[];
  /** In source order. */
  receiverBindings: readonly ReceiverBinding[];
  /**
   * The function values the source writes, each whole, in source order: the same arrows, function expressions, lambdas
   * and method references a function-value call is read through, and Java anonymous-class methods. What runs inside one
   * runs only when something runs the value.
   */
  functionValues: readonly SourceSpan[];
}

/**
 * A member call `r.m(...)` or `this.r.m(...)` whose receiver the source binds to one kind of value, or a member call
 * whose receiver is no name: a call result (`returned`) or another expression (`computed`), with `receiver` empty. The
 * rules see a receiver through parentheses, a non-null `!` and `satisfies` only; one they see through a wrapper and do
 * not bind, a type assertion, and any receiver of an optional call is `computed`. A bare `r` is bound
 * when every store into the binding (each initializer and each assignment) stores one kind: a literal of a library type,
 * an instance of one class the file names in `new`, or an instance of a class the file declares; failing that, when its
 * one declaration, a parameter or a variable, is annotated with one type. `this.r` is bound when the enclosing class
 * declares `r` once, as a field or a constructor property annotated with one type. A destructured or iterated binding, a
 * binding a dynamic scope or a direct `eval` may write, and any other store or annotation bind nothing.
 */
export interface ReceiverBinding {
  /** Where the call starts, 1-based. */
  line: number;
  column: number;
  receiver: string;
  member: string;
  holds: ReceiverValue;
  /** Candidate annotation only; the lexical reader did not prove the value is held by it. */
  unproven?: true;
}

/**
 * `literal`: a regular expression, array or string literal, an instance of that library type. `constructed`: `new name()`
 * where the file neither declares nor binds `name` except by an import, at the place of the first such `new`, so where
 * the name is rooted decides the class. `declared`: `new name()` of the one class declaration the file binds `name` to, at
 * the line of its name. `annotated`: the type the declaration states, at the place it is written (through parentheses,
 * `readonly` and a union with `null` or `undefined`): `type` is the first name of a type reference (`Map` for
 * `Map<K, V>`, `ng` for `ng.Router`), a primitive keyword (`string`), or `Array` for an array type; where the type is
 * declared decides what the call runs (ADR-0029 decision 9). `scoped`: a type parameter or a type an inner scope declares
 * binds `type` where it is written, so neither an import nor a top-level declaration of the file names it.
 */
export type ReceiverValue =
  | { kind: "literal"; type: "RegExp" | "Array" | "String" }
  /** The value a call returns, `name` the last name of its callee, at the place the call starts. */
  | { kind: "returned"; name: string; line: number; column: number }
  /** An expression no rule binds: an element access, an `await`, a conditional, a `new` of no plain name. */
  | { kind: "computed" }
  | { kind: "constructed"; name: string; line: number; column: number }
  | { kind: "declared"; name: string; line: number }
  | { kind: "annotated"; type: string; line: number; column: number; scoped?: true };

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
  construction?: true;
  name: string;
  /** The line of its first token, an annotation or a decorator included. */
  start: number;
  /** The line of its name; an index node of the declaration starts between `start` and this line. */
  nameLine: number;
  /** Abstract methods, interface methods without a body, overload signatures and ambient functions have none. */
  body: boolean;
  /** Neither static, private nor final, nor a function outside a type. */
  overridable: boolean;
  /** The type its declaration states it returns, as an annotation states a receiver's (`ReceiverValue` `annotated`). */
  returns?: Extract<ReceiverValue, { kind: "annotated" }>;
}

/**
 * Reads, with a language's own parser, the member names a source declares in value positions: object-literal keys at any
 * depth and in any context, assigned properties, and the members of classes, records, enums and anonymous classes; never
 * a name only a type declares. From the same parse it reads the source's callable declarations and the member calls
 * whose receiver it binds to a function value. Declared by its consumers: `core/application/navigation`, whose
 * `ReconciledCalls` aligns the index's calls with the written ones (ADR-0041), and `core/application/trace`, where a
 * member call whose name the index holds no node for runs repository code when a source declares that name or the
 * call's receiver holds a function value, so it is a cut, never an external call (RFC-0013 R6), and whether a reached
 * method has a body or can be overridden decides its dispatch cut (R10), which the index does not record.
 */
export interface DeclaredMemberNamesReader {
  /**
   * A source of a language the reader does not parse, or one the parser rejects, declares none. `facts` keeps what the
   * reader derives from the file alone between requests (ADR-0035).
   */
  memberNames(file: SourceFile, facts?: DerivedFacts): Promise<DeclaredMemberNames>;
}

/** A written call and the enclosing declarations that can own its execution, outermost first. */
export interface SyntaxCall {
  kind: "calls" | "instantiates";
  line: number;
  column: number;
  name: string;
  callee?: string;
  /** Exact source anchors used by indexers for the same invocation expression or statement. */
  anchors?: readonly { line: number; column: number }[];
  owners: readonly {
    /** This declaration's initialization executes in its enclosing body rather than owning a separate execution. */
    runsInEnclosingBody?: true;
    name: string; start: number; nameLine: number; nameColumn: number; startColumn: number; endLine: number; endColumn: number;
  }[];
}
