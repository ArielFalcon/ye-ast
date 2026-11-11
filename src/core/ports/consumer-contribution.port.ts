import type { Carrier, CarrierSite, FlowNext, FlowResult } from "../domain/contracts/consumer-flow.ts";
import type { Evidence } from "../domain/shared/fact.ts";
import type { LanguageProfile } from "../domain/languages/profiles.ts";
import type { FrameworkSignal } from "./framework-signal.port.ts";

export interface ConsumerReading {
  readonly language: LanguageProfile["language"];
}

/** A complete destination set for one occurrence in a proven context. */
export interface ContinuationClaim {
  readonly site: Evidence;
  readonly offset: number;
  readonly context: string;
  readonly next: readonly FlowNext[];
  readonly evidence: readonly Evidence[];
}

export interface ConsumerContribution {
  readonly associations?: readonly { site: Extract<CarrierSite, { kind: "return" }>; dependency: FrameworkSignal["dependency"] }[];
  readonly uncertainFiles?: readonly { file: string; dependency: FrameworkSignal["dependency"] }[];
  follow(carrier: Carrier): { flow: FlowResult; claims: readonly ContinuationClaim[] } | undefined;
}

export interface ConsumerContributionFactory {
  readonly signals?: readonly FrameworkSignal[];
  prepare(reading: ConsumerReading, repo: string): Promise<ConsumerContribution | undefined>;
}
