import type { SourceFile } from "./entrypoint-extractor.port.ts";

/** The member names one source declares where a value can live, read from its syntax. */
export interface DeclaredMemberNames {
  /** Sorted, once each. */
  names: readonly string[];
  /** The source defines a member under a computed name (`{ [key]: f }`, `target[key] = f`), which no name can be read from. */
  computed: boolean;
}

/**
 * Reads, with a language's own parser, the member names a source declares in value positions: object-literal keys at any
 * depth and in any context, assigned properties, and the members of classes, records, enums and anonymous classes; never
 * a name only a type declares. Declared by its consumer, `core/application/trace`: a member call whose name the index
 * holds no node for runs repository code when a source declares that name, so it is a cut, never an external call
 * (RFC-0013 R6).
 */
export interface DeclaredMemberNamesReader {
  /** A source of a language the reader does not parse, or one the parser rejects, declares none. */
  memberNames(file: SourceFile): Promise<DeclaredMemberNames>;
}
