export type Absence = "null" | "undefined";

/** A literal the code writes next to the value it compares. */
export type Literal = string | number | boolean;

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
