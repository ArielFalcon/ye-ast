export type Absence = "null" | "undefined";

/** A literal the code writes next to the value it compares. */
export type Literal = string | number | boolean;

/** A value a JSON document holds, as the code writes it literally. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type EqualityOperator = "===" | "!==" | "==" | "!=";

/**
 * What a guard tests about the value it covers, applied with the consumer language's own operators: its truthiness, an
 * equality with an absence or with a literal the code writes, the name `typeof` gives it, whether it is an array, or a
 * strict equality with any of several literals and absences, as the labels that reach one `switch` clause test it.
 */
export type Predicate =
  | { kind: "truthy" }
  | { kind: "absence"; operator: EqualityOperator; absence: Absence }
  | { kind: "literal"; operator: EqualityOperator; literal: Literal }
  | { kind: "typeof"; operator: EqualityOperator; type: string }
  | { kind: "array" }
  | { kind: "one-of"; literals: readonly Literal[]; absences: readonly Absence[] };

/** What a fallback puts in place of the values its test rejects: the JSON value its right side writes, or `opaque` for any other right side. */
export type Replacement = { kind: "literal"; value: JsonValue } | { kind: "opaque" };

/** One access the code writes past the changed segment, in order; `optional` when it is written with `?.`. */
export type AccessStep =
  | { kind: "member"; name: string; optional: boolean }
  | { kind: "keyed"; key?: string | number; optional: boolean }
  | { kind: "call"; optional: boolean };

/**
 * How the code ends with the value its steps reach; `none` states nothing beyond the steps. An operator is the token the
 * code writes; a `detail` is what the adapter names the construct by, such as the pipe or the function it hands the value to.
 */
export type UseEnd =
  | { kind: "none" }
  | { kind: "iterate"; tolerates: readonly Absence[] }
  | { kind: "destructure"; shape: "object" | "array" }
  | { kind: "compare"; operator: string; literal?: Literal }
  | { kind: "coerce"; operator: string }
  | { kind: "consume"; as: "shown" | "handed-on"; detail?: string }
  | { kind: "unmodelled"; detail: string };

/**
 * What a use does with the changed value, as the code writes it where the use is: the accesses past the changed segment
 * (a `keyed` read carries its key when the code writes a literal one), then how it ends.
 */
export interface UseOperation {
  steps: readonly AccessStep[];
  end: UseEnd;
}

/** The F0 reading of an operation: whether it dereferences the changed value, shows or hands it on, or neither. */
export type OperationClass = "dereference" | "consume" | "unmodelled";

export function operationClass(operation: UseOperation): OperationClass {
  if (operation.steps.length > 0) return "dereference";
  const { end } = operation;
  switch (end.kind) {
    case "iterate":
      return end.tolerates.includes("null") && end.tolerates.includes("undefined") ? "consume" : "dereference";
    case "destructure":
    case "none":
      return "dereference";
    case "compare":
    case "coerce":
    case "consume":
      return "consume";
    case "unmodelled":
      return "unmodelled";
  }
}
