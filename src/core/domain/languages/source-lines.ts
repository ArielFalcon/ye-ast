import { isJavaSource } from "./java.ts";

/**
 * The lines of a Java or TypeScript source that hold no code: blank, a `//` comment, or a block comment that opens the
 * line and closes at its end. A line inside a template literal or a text block is code. Where a line could be either,
 * it is code.
 */
export function linesWithoutCode(path: string, content: string): ReadonlySet<number> {
  const quote = isJavaSource(path) ? '"""' : "`";
  const quiet = new Set<number>();
  let inComment = false;
  let inString = false;
  content.split("\n").forEach((line, index) => {
    const number = index + 1;
    const text = line.trim();
    if (inComment) {
      const close = text.indexOf("*/");
      if (close === -1) return void quiet.add(number);
      inComment = false;
      if (isQuiet(text.slice(close + 2))) return void quiet.add(number);
    } else if (!inString) {
      if (text.startsWith("/*")) {
        const close = text.indexOf("*/", 2);
        if (close === -1) {
          inComment = true;
          return void quiet.add(number);
        }
        if (isQuiet(text.slice(close + 2))) return void quiet.add(number);
      } else if (isQuiet(text)) return void quiet.add(number);
    }
    if (occurrences(line, quote) % 2 === 1) inString = !inString;
  });
  return quiet;
}

function isQuiet(rest: string): boolean {
  const text = rest.trim();
  return text === "" || text.startsWith("//");
}

function occurrences(line: string, quote: string): number {
  let count = 0;
  for (let at = line.indexOf(quote); at !== -1; at = line.indexOf(quote, at + quote.length)) if (line[at - 1] !== "\\") count += 1;
  return count;
}
