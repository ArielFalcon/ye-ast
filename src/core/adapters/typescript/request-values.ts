import type { Evidence } from "../../domain/shared/fact.ts";
import type { SummaryGap } from "../../domain/topology/request-summary.ts";
import { prevailingCause } from "../../domain/topology/evaluated.ts";
import { compactRequestUrl, type RequestUrlPart } from "../../domain/topology/request-url.ts";

type Scalar = string | number | boolean | null | undefined;
export type RequestValue =
  | { kind: "literal"; value: Scalar }
  | { kind: "parameter"; index: number; propertiesSafe?: boolean; fallback?: RequestValue }
  | { kind: "unknown"; gap: SummaryGap }
  | { kind: "opaque"; value: RequestValue; gap: SummaryGap }
  | { kind: "provenance"; value: RequestValue; gap: SummaryGap }
  | { kind: "object"; fields: ReadonlyMap<string, RequestValue> }
  | { kind: "property"; owner: RequestValue; name: string; optional: boolean }
  | { kind: "choose"; condition: RequestValue; yes: RequestValue; no: RequestValue }
  | { kind: "operation"; operator: "+" | "!" | "||" | "&&" | "??" | "startsWith" | "trim-start" | "trim-end" | "encode"; operands: readonly RequestValue[] }
  | { kind: "apply"; body: RequestValue; arguments: readonly RequestValue[] };

type Value = (
  | { kind: "literal"; value: Scalar }
  | { kind: "parameter"; index: number; encoded?: true }
  | { kind: "unknown"; gap: SummaryGap }
  | { kind: "object"; fields: ReadonlyMap<string, Value>; opaque?: SummaryGap }
  | { kind: "text"; parts: readonly Value[] }
) & { readonly supplied: readonly number[] };

export interface RequestValueRead {
  url: readonly RequestUrlPart[];
  text: string;
  holes: readonly (number | undefined)[];
  encodings: readonly boolean[];
  supplied: readonly number[];
  unresolved?: SummaryGap;
  /** The URL each outcome of the one undecided condition states; present only when exactly one condition splits the value. */
  alternatives?: readonly (readonly RequestUrlPart[])[];
}

export const UNKNOWN_VALUE: Extract<RequestValue, { kind: "unknown" }> = { kind: "unknown", gap: { cause: "destination-undecidable", evidence: [] } };
export const ABSENT_VALUE: RequestValue = { kind: "literal", value: undefined };
const APPLICATIONS = new WeakMap<RequestValue, WeakMap<readonly RequestValue[], RequestValue>>();

export function applyRequestValue(body: RequestValue, arguments_: readonly RequestValue[]): RequestValue {
  let byArguments = APPLICATIONS.get(body);
  if (byArguments === undefined) { byArguments = new WeakMap(); APPLICATIONS.set(body, byArguments); }
  let value = byArguments.get(arguments_);
  if (value === undefined) { value = { kind: "apply", body, arguments: arguments_ }; byArguments.set(arguments_, value); }
  return value;
}

export function valueUnknown(evidence: readonly Evidence[], cause: SummaryGap["cause"] = "destination-undecidable"): RequestValue {
  return { kind: "unknown", gap: { cause, evidence } };
}

export function valueHasParameter(root: RequestValue): boolean {
  const seen = new Set<RequestValue>();
  const visit = (value: RequestValue): boolean => {
    if (seen.has(value)) return false;
    seen.add(value);
    if (value.kind === "parameter") return true;
    if (value.kind === "opaque" || value.kind === "provenance") return visit(value.value);
    if (value.kind === "choose") return visit(value.yes) || visit(value.no);
    if (value.kind === "apply") return visit(value.body) && value.arguments.some(visit);
    if (value.kind === "property") return visit(value.owner);
    if (value.kind === "operation") return value.operands.some(visit);
    if (value.kind === "object") return [...value.fields.values()].some(visit);
    return false;
  };
  return visit(root);
}

export function valueMayBeObject(root: RequestValue): boolean {
  const seen = new Set<RequestValue>();
  const visit = (value: RequestValue): boolean => {
    if (seen.has(value)) return false;
    seen.add(value);
    if (value.kind === "object" || value.kind === "parameter" || value.kind === "property") return true;
    if (value.kind === "opaque" || value.kind === "provenance") return visit(value.value);
    if (value.kind === "apply") return visit(value.body);
    if (value.kind === "choose") return visit(value.yes) || visit(value.no);
    return value.kind === "operation" && ["??", "||", "&&"].includes(value.operator) && value.operands.some(visit);
  };
  return visit(root);
}

export function readRequestValue(root: RequestValue, work?: { evaluations: number; inspections?: number }): RequestValueRead {
  const first = reduceRequestValue(root, work);
  if (first.splits !== 1) return first.read;
  const urls = [true, false].map((outcome) => reduceRequestValue(root, work, outcome).read.url);
  return new Set(urls.map((url) => JSON.stringify(url))).size === 2 ? { ...first.read, alternatives: urls } : first.read;
}

/** `outcome` forces the one undecided condition that tells two values apart; `splits` counts those conditions. */
function reduceRequestValue(root: RequestValue, work: { evaluations: number; inspections?: number } | undefined, outcome?: boolean): { read: RequestValueRead; splits: number } {
  let splits = 0;
  const empty: readonly Value[] = [];
  const environments = new Map<string, readonly Value[]>();
  const ids = new WeakMap<Value, number>();
  let nextId = 0;
  const memo = new WeakMap<RequestValue, Map<readonly Value[], Value>>();
  const dependencies = new WeakMap<RequestValue, ReadonlySet<number>>();
  const inputs = (term: RequestValue): ReadonlySet<number> => {
    const cached = dependencies.get(term);
    if (cached !== undefined) return cached;
    if (work?.inspections !== undefined) work.inspections++;
    const found = new Set<number>();
    const add = (value: RequestValue): void => { for (const index of inputs(value)) found.add(index); };
    switch (term.kind) {
      case "parameter": found.add(term.index); if (term.fallback !== undefined) add(term.fallback); break;
      case "opaque": case "provenance": add(term.value); break;
      case "choose": add(term.condition); add(term.yes); add(term.no); break;
      case "property": add(term.owner); break;
      case "operation": term.operands.forEach(add); break;
      case "object": term.fields.forEach(add); break;
      case "apply": for (const index of inputs(term.body)) { const argument = term.arguments[index]; if (argument !== undefined) add(argument); } break;
    }
    dependencies.set(term, found);
    return found;
  };
  const startsWithOf = (prefix: StatedPrefix, needle: string): Value | undefined => {
    const shared = Math.min(prefix.text.length, needle.length);
    if (prefix.text.slice(0, shared) !== needle.slice(0, shared)) return scalar(false);
    if (prefix.text.length >= needle.length) return scalar(true);
    return prefix.closed ? scalar(false) : undefined;
  };
  const trimmedStart = (value: Extract<Value, { kind: "text" }>): Value | undefined => {
    const parts = flattened(value);
    let index = 0;
    while (index < parts.length) {
      const part = parts[index]!;
      if (part.kind !== "literal" || typeof part.value !== "string") return undefined;
      const kept = part.value.replace(/^\/+/, "");
      if (kept !== "") return { kind: "text", parts: [{ ...part, value: kept }, ...parts.slice(index + 1)], supplied: value.supplied };
      index++;
    }
    return { kind: "literal", value: "", supplied: value.supplied };
  };
  const unknown = (gap = UNKNOWN_VALUE.gap): Value => ({ kind: "unknown", gap, supplied: [] });
  const uncertainty = (...values: Value[]): Value => {
    const gaps: SummaryGap[] = [];
    const collect = (value: Value): void => {
      if (value.kind === "unknown") gaps.push(value.gap);
      else if (value.kind === "text") value.parts.forEach(collect);
      else if (value.kind === "object" && value.opaque !== undefined) gaps.push(value.opaque);
    };
    values.forEach(collect);
    return unknown({ cause: prevailingCause(gaps.map((gap) => gap.cause)) ?? "destination-undecidable", evidence: [...new Map(gaps.flatMap((gap) => gap.evidence).map((item) => [JSON.stringify(item), item])).values()] });
  };
  const scalar = (value: Scalar): Value => ({ kind: "literal", value, supplied: [] });
  const supplied = (values: readonly Value[]): number[] => [...new Set(values.flatMap((value) => value.supplied))].sort((a, b) => a - b);
  const truth = (value: Value): boolean | undefined => value.kind === "literal" ? Boolean(value.value) : value.kind === "object" ? true : undefined;
  const environment = (values: readonly Value[]): readonly Value[] => {
    const key = values.map((value) => {
      if (!ids.has(value)) ids.set(value, ++nextId);
      return ids.get(value);
    }).join(",");
    const held = environments.get(key);
    if (held !== undefined) return held;
    environments.set(key, values);
    return values;
  };
  const evaluate = (term: RequestValue, args: readonly Value[]): Value => {
    const cached = memo.get(term)?.get(args);
    if (cached !== undefined) return cached;
    if (work) work.evaluations++;
    let result: Value;
    switch (term.kind) {
      case "literal": result = scalar(term.value); break;
      case "unknown": result = unknown(term.gap); break;
      case "parameter": {
        let value = args[term.index] ?? (args === empty ? undefined : scalar(undefined));
        if (value?.kind === "literal" && value.value === undefined && term.fallback !== undefined) value = evaluate(term.fallback, args);
        result = value?.kind === "object" && term.propertiesSafe === false ? { ...value, opaque: value.opaque ?? UNKNOWN_VALUE.gap } : value ?? { kind: "parameter", index: term.index, supplied: [] };
        break;
      }
      case "opaque": {
        const value = evaluate(term.value, args);
        result = value.kind === "object" ? { ...value, opaque: term.gap } : value;
        break;
      }
      case "provenance": {
        const enrich = (value: Value): Value => {
          if (value.kind === "unknown" && value.gap.cause === "destination-undecidable" && value.gap.evidence.length === 0) return { ...value, gap: term.gap };
          if (value.kind === "text") return { ...value, parts: value.parts.map(enrich) };
          return value;
        };
        result = enrich(evaluate(term.value, args));
        break;
      }
      case "object": result = { kind: "object", fields: new Map([...term.fields].map(([key, value]) => [key, evaluate(value, args)])), supplied: [] }; break;
      case "property": {
        const owner = evaluate(term.owner, args);
        if (owner.kind === "object") {
          if (owner.opaque !== undefined) { result = unknown(owner.opaque); break; }
          const field = owner.fields.get(term.name);
          result = field === undefined ? term.name in Object.prototype ? unknown() : scalar(undefined) : { ...field, supplied: supplied([owner, field]) };
        } else if (owner.kind === "literal" && owner.value == null && term.optional) result = scalar(undefined);
        else result = owner.kind === "unknown" ? owner : unknown();
        break;
      }
      case "choose": {
        const conditionValue = evaluate(term.condition, args);
        const condition = truth(conditionValue);
        if (condition !== undefined) result = evaluate(condition ? term.yes : term.no, args);
        else {
          const yes = evaluate(term.yes, args), no = evaluate(term.no, args);
          if (sameValue(yes, no)) result = { ...yes, supplied: supplied([yes, no]) };
          else {
            splits++;
            result = outcome === undefined ? { ...uncertainty(conditionValue, yes, no), supplied: yes.supplied.length > 0 && no.supplied.length > 0 ? supplied([yes, no]) : [] } : outcome ? yes : no;
          }
        }
        break;
      }
      case "apply": {
        const needed = inputs(term.body);
        const length = needed.size === 0 ? 0 : Math.max(...needed) + 1;
        const values = Array.from({ length }, (_, index) => {
          const argument = needed.has(index) ? term.arguments[index] : undefined;
          return argument === undefined ? absent : evaluate(argument, args);
        });
        const bound = term === root ? values.map((value, index) => term.arguments[index] === undefined ? value : { ...value, supplied: [...new Set([...value.supplied, index])] }) : values;
        result = evaluate(term.body, environment(bound));
        break;
      }
      case "operation": {
        const first = term.operands[0] === undefined ? unknown() : evaluate(term.operands[0], args);
        if (term.operator === "!") {
          const decided = truth(first);
          result = decided === undefined ? uncertainty(first) : scalar(!decided);
          break;
        }
        const secondTerm = term.operands[1];
        if (term.operator === "||" || term.operator === "&&" || term.operator === "??") {
          const decided = term.operator === "??" ? first.kind === "literal" ? first.value != null : first.kind === "object" ? true : undefined : truth(first);
          const left = term.operator === "&&" ? decided === false : decided === true;
          result = decided === undefined ? uncertainty(first, secondTerm === undefined ? unknown() : evaluate(secondTerm, args)) : left ? first : secondTerm === undefined ? unknown() : evaluate(secondTerm, args);
          break;
        }
        const second = secondTerm === undefined ? unknown() : evaluate(secondTerm, args);
        if (term.operator === "+") {
          if (first.kind === "literal" && second.kind === "literal" && typeof first.value === "string" && typeof second.value === "string") result = { kind: "literal", value: first.value + second.value, supplied: supplied([first, second]) };
          else result = { kind: "text", parts: [first, second], supplied: supplied([first, second]) };
        } else if (term.operator === "startsWith") {
          const prefix = statedPrefix(first);
          result = prefix === undefined || second.kind !== "literal" || typeof second.value !== "string" ? uncertainty(first, second) : startsWithOf(prefix, second.value) ?? uncertainty(first, second);
        } else if (term.operator === "encode" && first.kind === "parameter") result = { ...first, encoded: true };
        else if (first.kind === "literal" && typeof first.value === "string" && term.operator === "encode" && !first.value.isWellFormed()) result = { ...unknown(), supplied: first.supplied };
        else if (first.kind === "text" && term.operator === "trim-start") result = trimmedStart(first) ?? uncertainty(first);
        else if (first.kind === "literal" && typeof first.value === "string") {
          const text = term.operator === "encode" ? encodeURIComponent(first.value) : term.operator === "trim-start" ? first.value.replace(/^\/+/, "") : first.value.replace(/\/+$/, "");
          result = { kind: "literal", value: text, supplied: first.supplied };
        } else result = first.kind === "unknown" ? first : { ...unknown(), supplied: first.supplied };
        break;
      }
    }
    let byArguments = memo.get(term);
    if (byArguments === undefined) { byArguments = new Map(); memo.set(term, byArguments); }
    byArguments.set(args, result);
    return result;
  };
  const absent = scalar(undefined);
  const value = evaluate(root, empty);
  const parts: Value[] = [];
  const flatten = (item: Value): void => { if (item.kind === "text") item.parts.forEach(flatten); else parts.push(item); };
  flatten(value);
  let text = "";
  const holes: (number | undefined)[] = [];
  const encodings: boolean[] = [];
  const gaps: SummaryGap[] = [];
  const url: RequestUrlPart[] = [];
  for (const part of parts) {
    if (part.kind === "literal" && typeof part.value === "string") {
      text += part.value;
      url.push({ kind: "text", text: part.value });
      if (/[{}]/.test(part.value)) gaps.push(UNKNOWN_VALUE.gap);
    }
    else {
      text += "{}";
      holes.push(part.kind === "parameter" ? part.index : undefined);
      encodings.push(part.kind === "parameter" && part.encoded === true);
      if (part.kind === "unknown") gaps.push(part.gap);
      else if (part.kind !== "parameter") gaps.push(UNKNOWN_VALUE.gap);
      url.push(part.kind === "parameter" ? { kind: "runtime", ...(part.encoded ? { encoded: true as const } : {}) } : { kind: "unknown", ...(part.kind === "unknown" ? part.gap : UNKNOWN_VALUE.gap) });
    }
  }
  const evidence = [...new Map(gaps.flatMap((gap) => gap.evidence).map((item) => [JSON.stringify(item), item])).values()];
  const unresolved = gaps.length === 0 ? undefined : { cause: prevailingCause(gaps.map((gap) => gap.cause)) ?? "destination-undecidable", evidence };
  return { splits, read: { text, holes, encodings, supplied: value.supplied, url: compactRequestUrl(url), ...(unresolved === undefined ? {} : { unresolved }) } };
}

interface StatedPrefix { text: string; closed: boolean }

function flattened(value: Value): Value[] {
  return value.kind === "text" ? value.parts.flatMap(flattened) : [value];
}

/** The leading literal characters a value states, and whether they are all of it. */
function statedPrefix(value: Value): StatedPrefix | undefined {
  if (value.kind === "literal") return typeof value.value === "string" ? { text: value.value, closed: true } : undefined;
  if (value.kind !== "text") return undefined;
  const parts = flattened(value);
  const literals = parts.findIndex((part) => part.kind !== "literal" || typeof part.value !== "string");
  const leading = (literals < 0 ? parts : parts.slice(0, literals)).map((part) => (part.kind === "literal" ? part.value : ""));
  return { text: leading.join(""), closed: literals < 0 };
}

function sameValue(a: Value, b: Value): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "literal" && b.kind === "literal") return a.value === b.value;
  if (a.kind === "parameter" && b.kind === "parameter") return a.index === b.index && a.encoded === b.encoded;
  return a === b;
}
