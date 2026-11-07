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
 * derivation found there. A response breaks its readers when it introduces a value, so what it retires is compatible; a
 * request breaks its writers when the server stops accepting a value, so what it newly accepts is compatible. A
 * parameter no longer declared is to be reviewed, since a contract does not say whether a server rejects one it does not
 * declare.
 */
export const CONTRACT_CHANGE_RULES: {
  operation: Readonly<Record<OperationDelta, ContractChangeRule>>;
  response: Readonly<Record<ResponseDelta, ContractChangeRule>>;
  request: Readonly<Record<ShapeDelta, ContractChangeRule>>;
  parameter: Readonly<Record<ShapeDelta, ContractChangeRule>>;
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
  request: Object.freeze({
    removed: rule("request-property-removed", "breaking"),
    undeclared: rule("request-property-undeclared", "compatible"),
    "introduced-absence": rule("request-property-became-optional", "compatible"),
    "introduced-null": rule("request-property-became-nullable", "compatible"),
    "introduced-class": rule("request-property-type-widened", "compatible"),
    "literals-added": rule("request-property-enum-value-added", "compatible"),
    "literals-retired": rule("request-property-enum-value-removed", "breaking"),
    "retired-absence": rule("request-property-became-required", "breaking"),
    "retired-null": rule("request-property-became-non-nullable", "breaking"),
    "retired-class": rule("request-property-type-narrowed", "breaking"),
    "added-required": rule("request-required-property-added", "breaking"),
    "added-optional": rule("request-optional-property-added", "compatible"),
    "constraint-narrowed": rule("request-property-constraint-narrowed", "breaking"),
    "constraint-widened": rule("request-property-constraint-widened", "compatible"),
    "constraint-changed": rule("request-property-constraint-changed", "review"),
    "annotation-changed": rule("request-property-annotation-changed", "review"),
  }),
  parameter: Object.freeze({
    removed: rule("request-parameter-removed", "review"),
    undeclared: rule("request-parameter-undeclared", "compatible"),
    "introduced-absence": rule("request-parameter-became-optional", "compatible"),
    "introduced-null": rule("request-parameter-became-nullable", "compatible"),
    "introduced-class": rule("request-parameter-type-widened", "compatible"),
    "literals-added": rule("request-parameter-enum-value-added", "compatible"),
    "literals-retired": rule("request-parameter-enum-value-removed", "breaking"),
    "retired-absence": rule("request-parameter-became-required", "breaking"),
    "retired-null": rule("request-parameter-became-non-nullable", "breaking"),
    "retired-class": rule("request-parameter-type-narrowed", "breaking"),
    "added-required": rule("request-required-parameter-added", "breaking"),
    "added-optional": rule("request-optional-parameter-added", "compatible"),
    "constraint-narrowed": rule("request-parameter-constraint-narrowed", "breaking"),
    "constraint-widened": rule("request-parameter-constraint-widened", "compatible"),
    "constraint-changed": rule("request-parameter-constraint-changed", "review"),
    "annotation-changed": rule("request-parameter-annotation-changed", "review"),
  }),
});

export type RuleTarget = keyof typeof CONTRACT_CHANGE_RULES;
