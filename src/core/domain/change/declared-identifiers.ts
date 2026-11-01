const MODIFIERS = "(?:(?:export|declare|default|abstract|public|private|protected|static|final|sealed|async|override|synchronized|readonly)\\s+)*";
const NAME = "([A-Za-z_$][\\w$]*)";
const NOT_A_DECLARATION: ReadonlySet<string> = new Set(["return", "throw", "new", "else", "await", "yield", "typeof", "delete", "case", "if", "for", "while", "switch", "catch", "do", "try", "super", "this"]);

/** `function`, `class`, `interface`, `enum`, `record`, `type`, `namespace`, `const`, `let` and `var` declarations. */
const KEYWORD_DECLARATION = new RegExp(`^\\s*${MODIFIERS}(?:function\\*?|class|interface|enum|record|type|namespace|const|let|var)\\s+${NAME}`);

/** A method or function-like member: modifiers and a return type, or a name followed by a body, before the parameter list. */
const MEMBER_DECLARATION = new RegExp(`^\\s*(${MODIFIERS})((?:[\\w<>\\[\\],.?]+\\s+)?)${NAME}\\s*\\(`);

/**
 * The name a line of source declares, by the simple shapes of TypeScript, JavaScript and Java: keyword declarations
 * (`function`, `class`, `interface`, `enum`, `record`, `type`, `namespace`, `const`, `let`, `var`, after any modifiers)
 * and members written as `[modifiers] [type] name(`. A member with neither modifier nor type must open its body on the
 * line. A type holding a space, such as `Map<String, Foo>`, is not read. An import, an export list, an annotation and a destructuring declare nothing here.
 */
export function declaredIdentifier(line: string): string | undefined {
  const keyword = KEYWORD_DECLARATION.exec(line);
  if (keyword !== null) return keyword[1];
  const member = MEMBER_DECLARATION.exec(line);
  if (member === null) return undefined;
  const modifiers = member[1]!.trim();
  const type = member[2]!.trim();
  const name = member[3]!;
  if (NOT_A_DECLARATION.has(name) || NOT_A_DECLARATION.has(type)) return undefined;
  return modifiers !== "" || type !== "" || line.trimEnd().endsWith("{") ? name : undefined;
}
