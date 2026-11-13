/** A type as the library signatures write it in source form (`java.util.Map<K, ? extends java.lang.Number>`). */
export type TypeText =
  | { kind: "class"; name: string; args: readonly (TypeText | "wildcard")[] }
  | { kind: "variable"; name: string }
  /** A primitive, `void` or an array. */
  | { kind: "other" };

const PRIMITIVES: ReadonlySet<string> = new Set(["boolean", "byte", "char", "short", "int", "long", "float", "double", "void"]);

/** Reads one type; anything it does not recognize is `other`, which no caller settles. */
export function parseTypeText(text: string): TypeText {
  const cursor = { text, at: 0 };
  const parsed = readType(cursor);
  return parsed === "wildcard" || cursor.at < text.length ? { kind: "other" } : parsed;
}

/** The raw class of a type, when it is a class. */
export function classHead(text: string): string | undefined {
  const parsed = parseTypeText(text);
  return parsed.kind === "class" ? parsed.name : undefined;
}

/** The name of a type parameter as the signatures declare it: `T` for `T extends java.lang.Number`. */
export function typeParameterName(declaration: string): string {
  return declaration.split(" ")[0] ?? declaration;
}

interface Cursor {
  text: string;
  at: number;
}

function readType(cursor: Cursor): TypeText | "wildcard" {
  if (cursor.text[cursor.at] === "?") {
    cursor.at += 1;
    const bound = /^ (?:extends|super) /.exec(cursor.text.slice(cursor.at));
    if (bound !== null) {
      cursor.at += bound[0].length;
      readType(cursor);
    }
    return "wildcard";
  }
  const start = cursor.at;
  while (cursor.at < cursor.text.length && !"<,>[ ".includes(cursor.text[cursor.at]!)) cursor.at += 1;
  const name = cursor.text.slice(start, cursor.at);
  if (name === "") return { kind: "other" };
  const args: (TypeText | "wildcard")[] = [];
  if (cursor.text[cursor.at] === "<") {
    cursor.at += 1;
    for (;;) {
      args.push(readType(cursor));
      if (cursor.text[cursor.at] === ",") cursor.at += 2;
      else break;
    }
    if (cursor.text[cursor.at] !== ">") return { kind: "other" };
    cursor.at += 1;
  }
  let array = false;
  while (cursor.text.startsWith("[]", cursor.at)) {
    cursor.at += 2;
    array = true;
  }
  if (array || PRIMITIVES.has(name)) return { kind: "other" };
  return name.includes(".") ? { kind: "class", name, args } : { kind: "variable", name };
}
