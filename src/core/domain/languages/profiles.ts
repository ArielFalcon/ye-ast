import type { ImportOrder } from "../change/source-tokens.ts";
import { isJavaSource } from "./java.ts";
import { isTypeScriptFile, isTypeScriptSource } from "./typescript.ts";

/**
 * What the language-agnostic rules read about one language (ADR-0045 decision 12): its file rules, how it binds a call to
 * a type, and how a constructor calls another. A field enters when a base rule reads it.
 */
export interface LanguageProfile {
  language: "typescript" | "java";
  /** Whether a file is written in the language, tests included. */
  writes(path: string): boolean;
  /** Whether a file is a source the language's readers read. */
  reads(path: string): boolean;
  /** `structural`: a value's type is what it holds, so a call binds by the receiver's proofs; `nominal`: by its declared type. */
  typing: "structural" | "nominal";
  /** Whether the order of the language's import declarations carries meaning; read by the change rules, never by a path check. */
  importOrder: ImportOrder;
  /** The keywords a constructor calls its superclass's and its own class's constructors with; none where the language has no such call. */
  chaining?: { inherited: string; own: string };
}

export const TYPESCRIPT_PROFILE: LanguageProfile = { language: "typescript", writes: isTypeScriptFile, reads: isTypeScriptSource, typing: "structural", importOrder: "significant" };

export const JAVA_PROFILE: LanguageProfile = { language: "java", writes: isJavaSource, reads: isJavaSource, typing: "nominal", importOrder: "insignificant", chaining: { inherited: "super", own: "this" } };

export const LANGUAGE_PROFILES: readonly LanguageProfile[] = [TYPESCRIPT_PROFILE, JAVA_PROFILE];

/** The profile of the language a file is written in; none for a file no language writes. */
export function profileOf(path: string): LanguageProfile | undefined {
  return LANGUAGE_PROFILES.find((profile) => profile.writes(path));
}

/** Whether a file's language binds calls by `typing`. */
export function hasTyping(path: string, typing: LanguageProfile["typing"]): boolean {
  return profileOf(path)?.typing === typing;
}

/** Whether `name` is a constructor-chaining keyword of the language `path` is written in. */
export function isChaining(path: string, name: string): boolean {
  const chaining = profileOf(path)?.chaining;
  return chaining !== undefined && (name === chaining.inherited || name === chaining.own);
}

/** Whether a file is a source some language's readers read. */
export function isReadSource(path: string): boolean {
  return LANGUAGE_PROFILES.some((profile) => profile.reads(path));
}
