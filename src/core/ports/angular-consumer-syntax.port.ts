import type { CarrierSite, FlowResult, Hop } from "../domain/contracts/consumer-flow.ts";
import type { AccessPath } from "../domain/contracts/access-path.ts";
import type { Evidence, UnknownReason } from "../domain/shared/fact.ts";
import type { ConsumerReading } from "./consumer-contribution.port.ts";
import type { ImportedName, RouterVocabulary } from "./router-vocabulary.port.ts";

export interface InputSyntax {
  member: Extract<CarrierSite, { kind: "member" }>;
  at: Evidence;
  offset: number;
  declarations: readonly { name: ImportedName; kind: "decorator" | "initializer"; alias?: string; aliasUnreadable?: true; required: boolean }[];
}

export interface AngularConsumerSyntax {
  inputs(file: string, owner: string): readonly InputSyntax[] | undefined;
  readonly routes: readonly ResolverSyntax[];
  issues(file: string): readonly { at: Evidence; reason: UnknownReason }[];
  readonly uncertainFiles: readonly string[];
  sameProject(first: string, second: string): boolean;
  routeData(file: string, owner: string): readonly RouteDataSyntax[] | undefined;
  followExpression(expression: ExpressionHandle, path: AccessPath, hops: readonly Hop[]): FlowResult;
}

declare const expressionBrand: unique symbol;
export interface ExpressionHandle { readonly [expressionBrand]: true }
export interface RouteDataSyntax {
  at: Evidence;
  expression: ExpressionHandle;
  type?: ImportedName;
  injection?: { callee: ImportedName; token: ImportedName };
}

export interface ResolverSyntax {
  target: Extract<CarrierSite, { kind: "return" }>;
  key: string;
  at: Evidence;
  offset: number;
  component?: { file: string; owner: string };
  conditional?: true;
  root?: { at: Evidence; offset: number; bootstrap?: Evidence; bootstrapOffset?: number; configuration: ImportedName; features: readonly (ImportedName | "unreadable")[]; options?: readonly { name?: string; value: boolean | "unreadable" }[] | "unreadable" };
}

export type AngularConsumerSyntaxFactory = (reading: ConsumerReading, repo: string, router: RouterVocabulary) => Promise<AngularConsumerSyntax | undefined>;
