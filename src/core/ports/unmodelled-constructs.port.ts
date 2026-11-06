import type { SourceFile } from "./entrypoint-extractor.port.ts";

/**
 * The files whose declarations the code graph cannot place: they declare a construct its extractor does not model
 * (a Java `record`), so the graph lists their members under the wrong container or not at all.
 */
export interface UnmodelledConstructsReader {
  /** The paths among `sources` that declare such a construct, sorted; a source it cannot parse is not listed. */
  extract(sources: readonly SourceFile[]): Promise<readonly string[]>;
}
