import type { ShapeDelta } from "./shape-derivation.ts";

/**
 * What a difference can do to a party that conforms to the old contract: `breaking` when it can fail under the new one,
 * `review` when it may, `compatible` when it cannot. Whether a given consumer does fail is what its verdict answers.
 */
export type RuleLevel = "breaking" | "review" | "compatible";

export interface ContractChangeRule {
  /** Stable: the answer names the rule by it. */
  id: string;
  level: RuleLevel;
}

export type OperationDelta = "added" | "removed";

/** What a change did to a response: at a place of its success body, or to the rest of what it answers. */
export type ResponseDelta = ShapeDelta | "errors-changed" | "envelope-changed";

const rule = (id: string, level: RuleLevel): ContractChangeRule => Object.freeze({ id, level });

/**
 * The rule of each difference a change between two contracts can make, by the side of the exchange it is on and what the
 * derivation found there. A response breaks its readers when it introduces a value, so what it retires is compatible.
 */
export const CONTRACT_CHANGE_RULES: {
  operation: Readonly<Record<OperationDelta, ContractChangeRule>>;
  response: Readonly<Record<ResponseDelta, ContractChangeRule>>;
} = Object.freeze({
  operation: Object.freeze({
    added: rule("operation-added", "compatible"),
    removed: rule("operation-removed", "breaking"),
  }),
  response: Object.freeze({
    removed: rule("response-property-removed", "breaking"),
    undeclared: rule("response-property-undeclared", "breaking"),
    "introduced-absence": rule("response-property-became-optional", "breaking"),
    "introduced-null": rule("response-property-became-nullable", "breaking"),
    "introduced-class": rule("response-property-type-changed", "breaking"),
    "literals-added": rule("response-property-enum-value-added", "review"),
    "literals-retired": rule("response-property-enum-value-removed", "compatible"),
    "retired-absence": rule("response-property-became-required", "compatible"),
    "retired-null": rule("response-property-became-non-nullable", "compatible"),
    "retired-class": rule("response-property-type-narrowed", "compatible"),
    "added-required": rule("response-required-property-added", "compatible"),
    "added-optional": rule("response-optional-property-added", "compatible"),
    "constraint-narrowed": rule("response-property-constraint-narrowed", "compatible"),
    "constraint-widened": rule("response-property-constraint-widened", "review"),
    "constraint-changed": rule("response-property-constraint-changed", "review"),
    "annotation-changed": rule("response-property-annotation-changed", "compatible"),
    "errors-changed": rule("response-error-changed", "review"),
    "envelope-changed": rule("response-success-envelope-changed", "review"),
  }),
});

export type RuleTarget = keyof typeof CONTRACT_CHANGE_RULES;
