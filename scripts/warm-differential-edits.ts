/**
 * The single-file edits of the warm differential (RFC-0040 §4 step 2), as text transforms of Java and TypeScript
 * sources. They read no grammar: each looks for the line shape it changes and says when the file has none, so a step
 * is skipped rather than replaced by another edit.
 */

const JAVA = /\.java$/u;
/** A line that opens a method or function body: a parameter list closing before an opening brace, return type or `throws` between, never a lambda's arrow. */
const BODY_OPENER = /\)[^(){};=]*\{\s*$/u;
const ARROW = /->|=>/u;
const CONTROL_WORDS = new Set(["if", "for", "while", "switch", "catch", "return", "new", "throw", "else", "do", "try", "super", "this", "synchronized", "function", "constructor"]);
/** The first name followed by `(` on a line: in a body opener, the declared method or function. */
const DECLARED_NAME = /([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\s*\(/u;

/** A statement inserted as the first line of the first method or function body: the body changes, no declaration does. */
export function bodyEdit(path: string, text: string): string | undefined {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => BODY_OPENER.test(line) && !isControlLine(line));
  if (at === -1) return undefined;
  const statement = JAVA.test(path) ? "int yeAstEdit = 0;" : "let yeAstEdit = 0;";
  return [...lines.slice(0, at + 1), statement, ...lines.slice(at + 1)].join("\n");
}

/** The first method or function declared with a body is renamed: its callers in other files no longer name it. */
export function signatureEdit(path: string, text: string): string | undefined {
  const lines = text.split("\n");
  const own = baseName(path);
  for (const [index, line] of lines.entries()) {
    if (!BODY_OPENER.test(line) || isControlLine(line)) continue;
    const name = DECLARED_NAME.exec(line)?.[1];
    if (name === undefined || CONTROL_WORDS.has(name) || name === own) continue;
    const renamed = line.replace(DECLARED_NAME, (match, found: string) => match.replace(found, `${found}YeAst`));
    return [...lines.slice(0, index), renamed, ...lines.slice(index + 1)].join("\n");
  }
  return undefined;
}

/** A new file beside `path`: a copy whose own type name is suffixed, so it declares new symbols that use the same names. */
export function addedFile(path: string, text: string): { path: string; text: string } {
  const own = baseName(path);
  const dot = path.lastIndexOf(".");
  const ownPattern = new RegExp(`\\b${own.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "gu");
  return { path: `${path.slice(0, dot - own.length)}${own}YeAst${path.slice(dot)}`, text: text.replace(ownPattern, `${own}YeAst`) };
}

/** Text no Java or TypeScript grammar accepts, appended so the file stops parsing. */
export function unparsable(text: string): string {
  return `${text}\n}}} ((( yeAst\n`;
}

/** A template edit that renders another component: the element of `selector` is appended. */
export function templateEdit(text: string, selector: string): string {
  return `${text}\n<${selector}></${selector}>\n`;
}

/** The element selector an Angular `@Component` declares, from `selector: '...'`. */
export function componentSelector(text: string): string | undefined {
  return text.includes("@Component(") ? /selector:\s*['"`]([a-z][\w-]*)['"`]/u.exec(text)?.[1] : undefined;
}

function isControlLine(line: string): boolean {
  if (ARROW.test(line)) return true;
  const first = /^\s*(?:\}\s*)?([A-Za-z_$][\w$]*)/u.exec(line)?.[1];
  return first !== undefined && CONTROL_WORDS.has(first) && first !== "function";
}

function baseName(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file.slice(0, file.indexOf("."));
}
