/**
 * A typed `contract_consequences` source for normalization and schema tests, kept apart from the other families'
 * fixtures: two repositories at different snapshots (`api` serves the handlers, `web` holds the consumers and producers),
 * a derived answer with its contract places at both revisions, an unknown finding, a producer with a witness, and a
 * derivation that records a frontier.
 */
import type { ConsequencesValue, ConsequenceFinding, HypothesisAnswer, ProducerConsequence, UseConsequence } from "../core/domain/contracts/consequence-fact.ts";
import type { RepositoryEvidence } from "../core/domain/shared/repository-evidence.ts";
import { OLD_ACCEPTANCE, OLD_GUARANTEE } from "../core/domain/contracts/consequence-fact.ts";
import { factOf, inputsOf, shaRef, SHA_A, SHA_B, SHA_C } from "./composition-fixtures.testing.ts";
import type { ExecutedSource, PublicRead } from "./query-runner.ts";

export const API = "api";
export const WEB = "web";
export const HANDLER_FILE = "src/main/java/shop/OrdersController.java";
export const FIND_HANDLER = { path: HANDLER_FILE, symbol: "OrdersController.find", line: 11, endLine: 12 };
export const CREATE_HANDLER = { path: HANDLER_FILE, symbol: "OrdersController.create", line: 20, endLine: 22 };
export const SERVICE_FILE = "src/app/order.service.ts";
export const TEMPLATE_FILE = "src/app/order.component.html";

const web = (path: string, line: number, extra: Partial<RepositoryEvidence> = {}): RepositoryEvidence => ({ path, line, repo: WEB, ...extra });
const plain = ({ repo: _repo, ...evidence }: RepositoryEvidence) => evidence;

export const USE_PLACE = web(TEMPLATE_FILE, 1);
export const GUARDED_PLACE = web(TEMPLATE_FILE, 2);
export const GUARD_PLACE = web(TEMPLATE_FILE, 3);
export const WITNESS_PLACE = web(SERVICE_FILE, 28);
export const PRODUCER_CALL = web(SERVICE_FILE, 30);
export const CONTRACT_BASE = { path: "api/openapi.yaml", line: 10, repo: API };
export const CONTRACT_HEAD = { path: "api/openapi.yaml", line: 12, repo: API };
export const FRONTIER_PLACE = web("src/app/order.component.ts", 11, { via: "member" });
export const DERIVATION_FRONTIER_PLACE: RepositoryEvidence = { path: "api/openapi.yaml", line: 40, repo: API };

const findLink = { id: "link-find", basis: "exact" as const, call: { file: SERVICE_FILE, line: 16, symbol: "OrderService.find" }, handler: { ...FIND_HANDLER, repo: API } };
const createLink = { id: "link-create", basis: "exact" as const, call: { file: SERVICE_FILE, line: 30, symbol: "OrderService.create" }, handler: { ...CREATE_HANDLER, repo: API } };
const hop = (step: "http-call" | "response-body" | "argument", evidence: RepositoryEvidence) => ({ step, evidence });
const customerName = { steps: [{ kind: "member" as const, name: "customer", optional: false }, { kind: "member" as const, name: "name", optional: false }], end: { kind: "none" as const } };

const incompatibleUse: ConsequenceFinding<UseConsequence> = {
  status: "complete",
  evidence: [USE_PLACE],
  value: {
    repo: WEB, link: findLink, verdict: { kind: "incompatible", witness: "undefined", at: 1, failing: { kind: "member", name: "name", optional: false }, capability: "readable" },
    operation: customerName, path: "customer.name", changed: "customer",
    chain: [hop("http-call", web(SERVICE_FILE, 16, { via: "basis:exact" })), hop("response-body", web(SERVICE_FILE, 17))],
  },
};

const guardedUse: ConsequenceFinding<UseConsequence> = {
  status: "complete",
  evidence: [GUARDED_PLACE, GUARD_PLACE],
  value: {
    repo: WEB, link: findLink,
    verdict: { kind: "admits", guards: [{ kind: "optional-chain", test: { kind: "truthy" }, holds: true, covers: ["customer"], evidence: plain(GUARD_PLACE) }] },
    operation: customerName, path: "customer.name", changed: "customer",
    chain: [hop("http-call", web(SERVICE_FILE, 16, { via: "basis:exact" }))],
  },
};

const frontier: ConsequenceFinding<UseConsequence> = { status: "unknown", reason: "unresolved", evidence: [FRONTIER_PLACE] };

const incompatibleProducer: ConsequenceFinding<ProducerConsequence> = {
  status: "complete",
  evidence: [PRODUCER_CALL, WITNESS_PLACE],
  value: {
    repo: WEB, link: createLink, path: "total",
    verdict: { kind: "incompatible", witness: { value: "absent", at: plain(WITNESS_PLACE), hops: [{ step: "argument", evidence: plain(WITNESS_PLACE) }], conditions: [{ expression: "flag", holds: true, at: plain(WITNESS_PLACE) }] } },
    chain: [hop("http-call", web(SERVICE_FILE, 30, { via: "basis:exact" })), hop("argument", WITNESS_PLACE)],
  },
};

const responseAnswer: HypothesisAnswer = {
  status: "complete",
  hypothesis: { method: "GET", path: "/api/orders/{id}", target: "response", property: "customer", change: "removed" },
  oldContract: OLD_GUARANTEE,
  derivedFrom: { operation: "GET /api/orders/{id}", property: "customer", rules: ["response-property-became-nullable"], places: { base: CONTRACT_BASE, head: CONTRACT_HEAD } },
  findings: [incompatibleUse, guardedUse, frontier],
};

const requestAnswer: HypothesisAnswer = {
  status: "complete",
  hypothesis: { method: "POST", path: "/api/orders", target: "request", property: "total", change: "required" },
  oldContract: OLD_ACCEPTANCE,
  findings: [incompatibleProducer],
};

export function consequencesValue(): ConsequencesValue {
  return {
    repositorySnapshots: [{ repo: API, snapshot: shaRef(API, SHA_A) }, { repo: WEB, snapshot: shaRef(WEB, SHA_B) }],
    answers: [responseAnswer, requestAnswer],
    change: {
      base: "main", head: "HEAD", snapshots: { base: SHA_C, head: SHA_A },
      derivation: {
        ...factOf({
          differences: [],
          frontiers: [{ status: "unknown", reason: "unresolved", kind: "unknown-shape", operation: "GET /api/orders/{id}", property: "customer", evidence: [DERIVATION_FRONTIER_PLACE] }],
        }, { snapshot: shaRef(API, SHA_A) }),
      },
    },
  };
}

/** A change whose derivation found nothing to answer for but recorded a frontier: the answers are empty. */
export function frontierOnlyValue(): ConsequencesValue {
  const value = consequencesValue();
  return { ...value, answers: [] };
}

export function consequencesSource(value: ConsequencesValue = consequencesValue()): Extract<ExecutedSource, { family: "contract_consequences" }> {
  const read: PublicRead<ConsequencesValue> = {
    fact: factOf(value, { snapshot: shaRef(API, SHA_A), inputs: inputsOf({ declaredConfig: { base: "main", head: "HEAD" } }), evidence: [USE_PLACE, PRODUCER_CALL] }),
  };
  return {
    family: "contract_consequences",
    query: { name: "ye_ast_contract_consequences", arguments: { repo: API, base: "main", head: "HEAD" } },
    read,
    identityGuard: { changedIdentityPointers: [], changedArguments: false, changedSnapshot: false },
  };
}
