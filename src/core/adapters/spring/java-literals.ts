/** The value of a string, text block, character or integer literal, read as the Java Language Specification defines it. */
export type LiteralValue = { type: "string"; value: string } | { type: "char"; value: string } | { type: "int" | "long"; value: bigint };

const WHITESPACE = /[ \t\f\u000B\u001C-\u001F\u1680\u2000-\u2006\u2008-\u200A\u2028\u2029\u205F\u3000]/;
const TEXT_BLOCK_OPENING = /^[ \t\f]*(\r\n|\r|\n)/;
const INTEGER = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9][0-9_]*)([lL]?)$/;

export function stringLiteralValue(text: string): string | undefined {
  if (text.startsWith('"""')) return textBlockValue(text.slice(3, -3));
  return translateEscapes(translateUnicodeEscapes(text.slice(1, -1)));
}

export function charLiteralValue(text: string): string | undefined {
  return translateEscapes(translateUnicodeEscapes(text.slice(1, -1)));
}

export function integerLiteralValue(text: string): LiteralValue | undefined {
  const match = INTEGER.exec(text);
  if (match === null || match[1] === undefined) return undefined;
  const digits = match[1].replaceAll("_", "");
  const isLong = match[2] !== "";
  const decimal = !/^0[0-9xXbB]/.test(digits);
  const parsed = decimal ? BigInt(digits) : parseNonDecimal(digits);
  if (parsed === undefined) return undefined;
  const bits = isLong ? 64 : 32;
  return { type: isLong ? "long" : "int", value: decimal ? parsed : BigInt.asIntN(bits, parsed) };
}

/** JLS 3.3: a `\` begins a Unicode escape only when an even number of backslashes precedes it. */
function translateUnicodeEscapes(raw: string): string {
  let translated = "";
  let backslashes = 0;
  for (let index = 0; index < raw.length; ) {
    const character = raw[index] ?? "";
    const code = character === "\\" && backslashes % 2 === 0 && raw[index + 1] === "u" ? /^[0-9a-fA-F]{4}$/.exec(raw.slice(index + 2, index + 6))?.[0] : undefined;
    if (code !== undefined) {
      translated += String.fromCharCode(parseInt(code, 16));
      index += 6;
      backslashes = 0;
      continue;
    }
    backslashes = character === "\\" ? backslashes + 1 : 0;
    translated += character;
    index++;
  }
  return translated;
}

/** JLS 3.10.7; the line continuation (`\` before a line terminator) occurs only in a text block. */
function translateEscapes(text: string): string | undefined {
  const named: Readonly<Record<string, string>> = { b: "\b", s: " ", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "'": "'", "\\": "\\" };
  let value = "";
  for (let index = 0; index < text.length; ) {
    const character = text[index] ?? "";
    if (character !== "\\") {
      value += character;
      index++;
      continue;
    }
    const next = text[index + 1] ?? "";
    const octal = /^[0-3][0-7]{0,2}|^[4-7][0-7]?/.exec(text.slice(index + 1))?.[0];
    if (octal !== undefined) {
      value += String.fromCharCode(parseInt(octal, 8));
      index += 1 + octal.length;
    } else if (named[next] !== undefined) {
      value += named[next];
      index += 2;
    } else if (next === "\n") {
      index += 2;
    } else {
      return undefined;
    }
  }
  return value;
}

/** JLS 3.10.6: line terminators become LF, the incidental indentation and trailing white space are removed, then the escapes are read. */
function textBlockValue(body: string): string | undefined {
  const lines = translateUnicodeEscapes(body.replace(TEXT_BLOCK_OPENING, "")).replace(/\r\n|\r/g, "\n").split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  const significant = [...lines.filter((line) => !isBlank(line)), ...(isBlank(lastLine) ? [lastLine] : [])];
  const strip = Math.min(...significant.map(leadingWhitespace));
  const stripped = lines.map((line) => trimTrailingWhitespace(line.slice(Math.min(strip, leadingWhitespace(line)))));
  return translateEscapes(stripped.join("\n"));
}

function isBlank(line: string): boolean {
  return [...line].every((character) => WHITESPACE.test(character));
}

function leadingWhitespace(line: string): number {
  let count = 0;
  while (count < line.length && WHITESPACE.test(line[count] ?? "")) count++;
  return count;
}

function trimTrailingWhitespace(line: string): string {
  let end = line.length;
  while (end > 0 && WHITESPACE.test(line[end - 1] ?? "")) end--;
  return line.slice(0, end);
}

function parseNonDecimal(digits: string): bigint | undefined {
  if (/^0[xXbB]/.test(digits)) return digits.length > 2 ? BigInt(digits) : undefined;
  return /^[0-7]+$/.test(digits) ? BigInt(`0o${digits.slice(1)}`) : undefined;
}
