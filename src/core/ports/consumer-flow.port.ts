import type { Carrier, FlowResult } from "../domain/contracts/consumer-flow.ts";

/**
 * Follows a value through TypeScript code, one boundary at a time. Given where the value is held and where the changed
 * property sits in it, answers what the code does with it inside that boundary (locals, lambda parameters, `pipe`,
 * `subscribe`, `await`, `toSignal`, `observe: 'response'` reaching `body`), the boundaries it leaves by, and the places
 * it is lost. A boundary is a call-site, call-result, return or member carrier; the reader never walks past one, and
 * resolving the callers of a return is the use case's job. A carrier it cannot place is a frontier, never an empty result.
 */
export interface ConsumerFlowReader {
  follow(carrier: Carrier): FlowResult;
}
