import type { Evidence, UnknownReason } from "../shared/fact.ts";
import type { ContractOperation } from "./contract-operation.ts";
import type { Literal } from "./use-operation.ts";

/** The classes of value that carry literals: a place holds every value of one, or only the listed literals. */
export const LITERAL_CLASSES = ["boolean", "number", "string"] as const;

export type LiteralClass = (typeof LITERAL_CLASSES)[number];

/** Every value of a literal class, or exactly the listed literals (none when the list is empty). */
export type ClassValues = "every" | readonly Literal[];

/** What a place of a payload may hold. Absence is apart from the classes: whether a property is required is not whether it is declared. */
export interface ValueSet {
  literals: Readonly<Record<LiteralClass, ClassValues>>;
  array: boolean;
  object: boolean;
  null: boolean;
  absent: boolean;
}

/** One property of an object place. `required` says whether the place may be absent, which the property's own value set never states. */
export interface ShapeProperty {
  name: string;
  required: boolean;
  shape: Shape;
}

/** A place the reader states: what it may hold and, below it, its properties and elements. */
export interface KnownShape {
  kind: "known";
  values: ValueSet;
  /** Present when the place may hold an object: the declared properties, sorted by name; an undeclared one holds every value when `open`, nothing otherwise. */
  object?: { properties: readonly ShapeProperty[]; open: boolean };
  /** Present when the place may hold an array: the shape of its elements. */
  elements?: Shape;
  /** The JSON Schema keywords the place carries that its value set does not state (bounds, patterns, annotations), by keyword; absent when it carries none. */
  keywords?: Readonly<Record<string, unknown>>;
}

/** A place the reader cannot state; nothing below it is derived. */
export interface UnknownShape {
  kind: "unknown";
  reason: UnknownReason;
  evidence: readonly Evidence[];
}

export type Shape = KnownShape | UnknownShape;

/** A shape and the repository files it depends on, sorted: the ones it was read from, and the ones a reference names that could not be read, so a revision that holds one it did not hold before changes the shape. */
export interface ReadShape {
  shape: Shape;
  files: readonly string[];
}

/** A place that may hold any value: what an undeclared property of an open object holds. */
export const ANYTHING: KnownShape = Object.freeze({
  kind: "known",
  values: Object.freeze({ literals: Object.freeze({ boolean: "every", number: "every", string: "every" } as const), array: true, object: true, null: true, absent: false }),
});

/**
 * Digests of what an operation exchanges beside its success body, each differing exactly when that part differs: its
 * request, its non-success responses, and its success responses without their schemas (status, media types, headers).
 */
export interface ExchangeDigests {
  request: string;
  errors: string;
  envelope: string;
}

/** The shape of the success response of one operation; `digests` is absent when its reader cannot state them. */
export type OperationShape = Pick<ContractOperation, "operationId" | "method" | "path" | "basePath"> & ReadShape & { digests?: ExchangeDigests };
