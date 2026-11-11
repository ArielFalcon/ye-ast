import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { buildProgram } from "./consumer-flow.index.ts";
import { consumerFlowReader } from "./consumer-flow.adapter.ts";
import { createRequestOriginReader } from "./request-origins.adapter.ts";
import { createRequestBodies } from "./http-call-sites.adapter.ts";

export interface ConsumerReadersDeps {
  buildProgram: typeof buildProgram;
  createRequestBodies: typeof createRequestBodies;
}

const defaultDeps: ConsumerReadersDeps = { buildProgram, createRequestBodies };

/** Both readers hold one program for this reading; origin-specific preparation stays lazy. */
export async function createConsumerReaders(files: readonly SourceFile[], repo: string, deps: ConsumerReadersDeps = defaultDeps) {
  let held: ReturnType<typeof buildProgram> | undefined;
  const program = () => (held ??= deps.buildProgram(files));
  return {
    flow: consumerFlowReader(await program(), repo),
    origins: createRequestOriginReader(files, program, deps.createRequestBodies),
  };
}
