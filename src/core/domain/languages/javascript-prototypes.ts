/** What a member of a built-in prototype holds: a function, a number, or an object (an accessor such as `__proto__`). */
export type MemberKind = "function" | "number" | "object";

const members = (functions: string, others: Readonly<Record<string, MemberKind>> = {}): ReadonlyMap<string, MemberKind> =>
  new Map<string, MemberKind>([...functions.split(" ").map((name): [string, MemberKind] => [name, "function"]), ...Object.entries(others)]);

/**
 * The string-keyed own members of the built-in prototypes, frozen at ECMAScript 2025 with the Annex B members engines
 * ship (the `String` HTML methods, `substr`, `trimLeft`, `trimRight`, the `Object` `__proto__` and `__define*__` family).
 * Built once; the running engine is never consulted.
 */
export const OBJECT_PROTOTYPE = members("constructor hasOwnProperty isPrototypeOf propertyIsEnumerable toLocaleString toString valueOf __defineGetter__ __defineSetter__ __lookupGetter__ __lookupSetter__", { ["__proto__"]: "object" });

export const ARRAY_PROTOTYPE = members(
  "constructor at concat copyWithin entries every fill filter find findIndex findLast findLastIndex flat flatMap forEach includes indexOf join keys lastIndexOf map pop push reduce reduceRight reverse shift slice some sort splice toLocaleString toReversed toSorted toSpliced toString unshift values with",
  { length: "number" },
);

export const STRING_PROTOTYPE = members(
  "constructor anchor at big blink bold charAt charCodeAt codePointAt concat endsWith fixed fontcolor fontsize includes indexOf isWellFormed italics lastIndexOf link localeCompare match matchAll normalize padEnd padStart repeat replace replaceAll search slice small split startsWith strike sub substr substring sup toLocaleLowerCase toLocaleUpperCase toLowerCase toString toUpperCase toWellFormed trim trimEnd trimLeft trimRight trimStart valueOf",
  { length: "number" },
);

export const NUMBER_PROTOTYPE = members("constructor toExponential toFixed toLocaleString toPrecision toString valueOf");

export const BOOLEAN_PROTOTYPE = members("constructor toString valueOf");
