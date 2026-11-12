import type { LanguageProfile } from "../domain/languages/profiles.ts";

export interface FrameworkValueReading { readonly language: LanguageProfile["language"] }
/** UTF-16 offsets in the held source, with an exclusive end. */
export interface SourceExpression { file: string; start: number; end: number }
export interface FrameworkValues {
  valueOf(expression: SourceExpression): Promise<SourceExpression | undefined>;
}
export interface FrameworkValueFactory {
  prepare(reading: FrameworkValueReading): Promise<FrameworkValues | undefined>;
}
