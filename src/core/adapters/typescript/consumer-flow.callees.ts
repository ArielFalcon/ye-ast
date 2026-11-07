import type { FlowStep } from "../../domain/contracts/consumer-flow.ts";

/**
 * Where the value goes after a method call on a carried value: it stays the receiver's own value (`same`), is one
 * element of it, becomes the elements of a new array from the callback's returns (`flattened-returns` flattens one
 * level), or reaches no result (a boolean, a number, a string). A callback of any other result only has its return tested.
 */
export type MethodResult = "same" | "element" | "returns" | "flattened-returns" | "none";

/** What a method does with the value it is called on, by receiver kind; `callback` names the argument that receives the element or the value, and which of its parameters do. */
export interface MethodRow {
  receiver: "array" | "container";
  callback?: { argument: number; parameters: readonly number[] };
  result: MethodResult;
}

const array = (result: MethodResult, callback?: MethodRow["callback"]): MethodRow => ({ receiver: "array", result, ...(callback === undefined ? {} : { callback }) });
const predicate = array("none", { argument: 0, parameters: [0] });

/**
 * The methods of the language's arrays, read when the carried value is an array that holds the change in its elements:
 * a carried value is the parsed response or a part of it, so its array is the intrinsic one. A method absent from the
 * table is not followed: `reduce` binds the accumulator to the callback's return, and `fill` and `copyWithin` replace elements.
 */
export const METHODS: ReadonlyMap<string, MethodRow> = new Map<string, MethodRow>([
  ["map", array("returns", { argument: 0, parameters: [0] })],
  ["flatMap", array("flattened-returns", { argument: 0, parameters: [0] })],
  ["filter", array("same", { argument: 0, parameters: [0] })],
  ["sort", array("same", { argument: 0, parameters: [0, 1] })],
  ["toSorted", array("same", { argument: 0, parameters: [0, 1] })],
  ["find", array("element", { argument: 0, parameters: [0] })],
  ["findLast", array("element", { argument: 0, parameters: [0] })],
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
  ["asReadonly", { receiver: "container", result: "same" }],
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
