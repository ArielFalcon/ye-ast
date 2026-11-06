import type { AccessPath } from "../domain/contracts/access-path.ts";
import type { CarrierSite, FlowResult } from "../domain/contracts/consumer-flow.ts";

export interface MemberCarrier {
  site: Extract<CarrierSite, { kind: "member" }>;
  path: AccessPath;
}

/**
 * Follows a component member into the template of its owner: reads of the member with the guards that cover them
 * (`?.`, `@if` and `*ngIf` tests on a prefix that includes the changed segment, `as` aliases, `@for` items, `??` and `||`),
 * and the inputs of child components it is bound to with `[name]="path"`, which continue as member carriers of the child.
 * An owner without a template, or one that does not parse, is a frontier.
 */
export interface ConsumerTemplateReader {
  follow(carrier: MemberCarrier): FlowResult;
}
