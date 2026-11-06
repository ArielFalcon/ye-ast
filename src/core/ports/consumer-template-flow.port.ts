import type { FlowResult } from "../domain/contracts/consumer-flow.ts";
import type { MemberCarrier } from "./consumer-template.port.ts";
import type { TemplateUnit } from "./template-usage.port.ts";

/**
 * Reads the template of the carrier's component for that one member. A child component input bound to the value
 * continues as a member carrier of the scope member the element matches: `file` and `owner` from its `ref`, no `line`.
 */
export interface TemplateFlowReader {
  follow(unit: TemplateUnit, carrier: MemberCarrier): FlowResult;
}
