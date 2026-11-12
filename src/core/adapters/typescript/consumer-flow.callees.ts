import type { FlowStep } from "../../domain/contracts/consumer-flow.ts";

/**
 * Where the value goes after a method call on a carried value: it stays the receiver's own value (`same`), is one
 * element of it, becomes the elements of a new array from the callback's returns (`flattened-returns` flattens one
 * level), or reaches no result (a boolean, a number, a string). A callback of any other result only has its return tested.
 */
export type MethodResult = "same" | "element" | "returns" | "flattened-returns" | "none";

/** What a callback parameter holds: one element of the receiver array, or the receiver array itself. A parameter that holds neither (the index) is not listed. */
export interface CallbackParameter {
  index: number;
  holds: "element" | "array";
}

/** What an intrinsic array method does with the value it is called on; `callback` names the argument that receives the value, and what each of its parameters holds. */
export interface MethodRow {
  callback?: { argument: number; parameters: readonly CallbackParameter[] };
  result: MethodResult;
}

const array = (result: MethodResult, callback?: MethodRow["callback"]): MethodRow => ({ result, ...(callback === undefined ? {} : { callback }) });
const iteratee = { argument: 0, parameters: [{ index: 0, holds: "element" }, { index: 2, holds: "array" }] } as const satisfies MethodRow["callback"];
const comparator = { argument: 0, parameters: [{ index: 0, holds: "element" }, { index: 1, holds: "element" }] } as const satisfies MethodRow["callback"];
const predicate = array("none", iteratee);

/**
 * The methods of the language's arrays, read when the carried value is an array that holds the change in its elements:
 * a carried value is the parsed response or a part of it, so its array is the intrinsic one. A method absent from the
 * table is not followed: `reduce` binds the accumulator to the callback's return, and `fill` and `copyWithin` replace elements.
 */
export const METHODS: ReadonlyMap<string, MethodRow> = new Map<string, MethodRow>([
  ["map", array("returns", iteratee)],
  ["flatMap", array("flattened-returns", iteratee)],
  ["filter", array("same", iteratee)],
  ["sort", array("same", comparator)],
  ["toSorted", array("same", comparator)],
  ["find", array("element", iteratee)],
  ["findLast", array("element", iteratee)],
  ["findIndex", predicate],
  ["findLastIndex", predicate],
  ["some", predicate],
  ["every", predicate],
  ["forEach", predicate],
  ["slice", array("same")],
  ["concat", array("same")],
  ["reverse", array("same")],
  ["toReversed", array("same")],
  ["splice", array("same")],
  ["toSpliced", array("same")],
  ["at", array("element")],
  ["pop", array("element")],
  ["shift", array("element")],
  ["indexOf", array("none")],
  ["lastIndexOf", array("none")],
  ["includes", array("none")],
  ["join", array("none")],
  ["push", array("none")],
  ["unshift", array("none")],
]);

/** An imported function that hands the value it receives as its first argument on as its own result, or as the value of its container. */
export interface FunctionRow {
  module: string;
  name: string;
  step?: FlowStep;
}

export const FUNCTIONS: readonly FunctionRow[] = [
  { module: "rxjs", name: "firstValueFrom" },
  { module: "rxjs", name: "lastValueFrom" },
  { module: "rxjs", name: "of" },
  { module: "@angular/core", name: "toSignal", step: "to-signal" },
];

export const isModule = (actual: string | undefined, module: string): boolean => actual === module || actual?.startsWith(`${module}/`) === true;
