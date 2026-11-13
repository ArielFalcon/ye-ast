/**
 * The types of a route's path variable that parse their text strictly: a segment that is not a number, or not a UUID,
 * fails the producer at run time. Any other type, and any language or framework that gives none, states no type.
 */
export const PARSE_STRICT_TYPES = ["UUID", "byte", "Byte", "short", "Short", "int", "Integer", "long", "Long", "float", "Float", "double", "Double"] as const;

export type ParseStrictType = (typeof PARSE_STRICT_TYPES)[number];

/** The declared type of the path variables of a route that have a parse-strict one, by variable name. */
export type RouteParameterTypes = Readonly<Record<string, ParseStrictType>>;

const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFdD]?$/;
const NON_FINITE = /^[+-]?(?:NaN|Infinity)$/;
/** `UUID.fromString` takes five dash-separated groups of at most 16 hex digits. */
const UUID_TEXT = /^[0-9a-fA-F]{1,16}(?:-[0-9a-fA-F]{1,16}){4}$/;

export function isParseStrictType(type: string): type is ParseStrictType {
  return (PARSE_STRICT_TYPES as readonly string[]).includes(type);
}

/** Whether a type of `PARSE_STRICT_TYPES` can parse the text; the readings are the permissive side of Java's, so a mismatch is certain. */
export function parsesAs(type: ParseStrictType, text: string): boolean {
  if (type === "UUID") return UUID_TEXT.test(text);
  if (type === "float" || type === "Float" || type === "double" || type === "Double") return DECIMAL.test(text) || NON_FINITE.test(text);
  return INTEGER.test(text);
}

/** The variable a whole route segment is (`{id}` or `{id:regex}`); undefined for text, a wildcard or a segment that mixes both. */
export function variableOfSegment(segment: string): string | undefined {
  return /^\{([^/{}:*]+)(?::.*)?\}$/.exec(segment)?.[1];
}
