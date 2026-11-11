import { CUT_REASONS, CUT_SUB_REASONS, UNKNOWN_REASONS } from "../core/domain/shared/fact.ts";
import { dependencyDiagnostic } from "./dependency-schema.ts";
import { z } from 'zod';
import { RESULT_IDENTITY_PATTERN } from './evidence-cursor.ts';
import type { CrossField } from './compact-schema.ts';

type Tool = 'entrypoints' | 'callers' | 'impact';
const index = z.int().nonnegative();
const positive = z.int().positive();
const reason = z.enum(UNKNOWN_REASONS);
const cutKind = z.enum(['depth','hub','caller-budget','node-cap','unresolved-link','deadline','section','not-exported','no-extractor']);
const text = z.string().min(1);
const local = z.strictObject({kind: z.literal('local')});
const section = z.strictObject({kind: z.literal('section'), repo: text});
const fact = z.strictObject({kind: z.literal('fact')});
const entrypoints = z.strictObject({kind: z.literal('entrypoints')});
const read = z.strictObject({kind: z.literal('read'), repo: text, index});
const impactOwner = z.union([local, section]);
const cutOwner = z.union([fact, entrypoints, section, read]);
const subjectHandler = z.strictObject({path: text, symbol: text, line: positive});
const handlerSelection = z.strictObject({kind: z.literal('handler-origins'), owner: impactOwner, handler: subjectHandler});
const moduleSelection = z.strictObject({kind: z.literal('module-origins'), owner: impactOwner, module: z.strictObject({file: text, snapshot: z.enum(['base','head'])})});
const findingSelection = z.strictObject({kind: z.literal('entrypoint-evidence'), findingIndex: index});
const cutSelection = z.strictObject({kind: z.literal('cut-places'), owner: cutOwner, cutIndex: index});
const linkSelection = z.strictObject({kind: z.literal('workspace-link-evidence'), linkId: text});
const selection = z.discriminatedUnion('kind', [handlerSelection, moduleSelection, findingSelection, cutSelection, linkSelection]);
const pageRequest = z.strictObject({limit: positive.describe('Positive safe count of primary records; no default.'), cursor: z.string().optional().describe('Returned nextCursor, same selection/limit; rechecks identity.')});

type OwnerKind = 'local' | 'section' | 'fact' | 'entrypoints' | 'read';
type SelectionKind = z.infer<typeof selection>['kind'];
type Branch = Partial<Record<SelectionKind, readonly OwnerKind[]>>;

/**
 * The one eligibility policy of the recovery controls: per tool and per actual workspace branch, the selection kinds a
 * request may name and, for owned kinds, the owners it accepts. An empty owner list marks a kind without an owner.
 * Runtime validation, explanatory issues, the published constraints and the per-tool input shapes all derive from it.
 */
const ELIGIBILITY: Record<Tool, {local: Branch; workspace?: Branch}> = {
  entrypoints: {local: {'entrypoint-evidence': [], 'cut-places': ['fact', 'entrypoints']}},
  callers: {
    local: {'handler-origins': ['local'], 'cut-places': ['fact']},
    workspace: {'handler-origins': ['section'], 'cut-places': ['fact', 'section', 'read'], 'workspace-link-evidence': []},
  },
  impact: {
    local: {'handler-origins': ['local'], 'module-origins': ['local'], 'cut-places': ['fact']},
    workspace: {'handler-origins': ['section'], 'module-origins': ['section'], 'cut-places': ['fact', 'section', 'read'], 'workspace-link-evidence': []},
  },
};
const KIND_ORDER: readonly SelectionKind[] = ['entrypoint-evidence', 'handler-origins', 'module-origins', 'cut-places', 'workspace-link-evidence'];
const OWNERS: Record<OwnerKind, z.ZodType> = {local, section, fact, entrypoints, read};
const OWNER_SHAPE: Record<OwnerKind, string> = {local: '{"kind":"local"}', section: '{"kind":"section","repo"}', fact: '{"kind":"fact"}', entrypoints: '{"kind":"entrypoints"}', read: '{"kind":"read","repo","index"}'};
const SUBJECT_SHAPE: Record<SelectionKind, string> = {
  'entrypoint-evidence': '"findingIndex"',
  'handler-origins': '"handler":{"path","symbol","line"}',
  'module-origins': '"module":{"file","snapshot":"base"|"head"}',
  'cut-places': '"cutIndex"',
  'workspace-link-evidence': '"linkId"',
};

const branchesOf = (tool: Tool): Branch[] => [ELIGIBILITY[tool].local, ...(ELIGIBILITY[tool].workspace ? [ELIGIBILITY[tool].workspace] : [])];
const kindsOf = (tool: Tool): SelectionKind[] => KIND_ORDER.filter((kind) => branchesOf(tool).some((branch) => branch[kind] !== undefined));
const ownersOf = (tool: Tool, kind: SelectionKind): OwnerKind[] => [...new Set(branchesOf(tool).flatMap((branch) => branch[kind] ?? []))];
const branchOf = (tool: Tool, workspace: boolean): Branch => (workspace && ELIGIBILITY[tool].workspace) || ELIGIBILITY[tool].local;
const list = (items: readonly string[]) => items.join(' or ');

function shapeOf(tool: Tool, kind: SelectionKind): string {
  const owners = ownersOf(tool, kind);
  return `{"kind":"${kind}",${owners.length ? `"owner":${list(owners.map((owner) => OWNER_SHAPE[owner]))},` : ''}${SUBJECT_SHAPE[kind]}}`;
}

/** Which kinds and owners each branch accepts, stated only when the branches differ. */
function branchRule(tool: Tool): string {
  const {local: localBranch, workspace: workspaceBranch} = ELIGIBILITY[tool];
  if (workspaceBranch === undefined) return '';
  const describe = (branch: Branch) => KIND_ORDER.filter((kind) => branch[kind] !== undefined).map((kind) => branch[kind]!.length ? `${kind} owner ${list(branch[kind]!)}` : kind).join('; ');
  return ` Without workspace: ${describe(localBranch)}. With workspace: ${describe(workspaceBranch)}.`;
}

/** The owners of one kind in each branch, stated only when the branches differ. */
function ownerRule(tool: Tool, kind: SelectionKind): string {
  const {local: localBranch, workspace: workspaceBranch} = ELIGIBILITY[tool];
  if (workspaceBranch === undefined) return '';
  const owners = (branch: Branch) => branch[kind] === undefined ? 'unavailable' : list(branch[kind]!);
  return ` (without workspace: ${owners(localBranch)}; with workspace: ${owners(workspaceBranch)})`;
}

const selectionGuide = (tool: Tool) => `select must be one of ${kindsOf(tool).map((kind) => shapeOf(tool, kind)).join('; ')}.${branchRule(tool)}`;

function selectionFor(tool: Tool, kind: SelectionKind) {
  const owners = ownersOf(tool, kind);
  const ownerSubsetOf = <T extends z.ZodType>(_publicOwner: T) => z.union(owners.map((name) => OWNERS[name]), {error: `owner for ${kind} must be ${list(owners.map((name) => OWNER_SHAPE[name]))}${ownerRule(tool, kind)}`}) as unknown as T;
  switch (kind) {
    case 'entrypoint-evidence': return findingSelection;
    case 'workspace-link-evidence': return linkSelection;
    case 'handler-origins': return handlerSelection.extend({owner: ownerSubsetOf(impactOwner)});
    case 'module-origins': return moduleSelection.extend({owner: ownerSubsetOf(impactOwner)});
    case 'cut-places': return cutSelection.extend({owner: ownerSubsetOf(cutOwner)});
  }
}

/** Only the kinds and owners the tool accepts in some branch; the actual branch is checked by the recovery control issues. */
function selectionsFor(tool: Tool) {
  const [first, ...rest] = kindsOf(tool).map((kind) => selectionFor(tool, kind));
  return z.discriminatedUnion('kind', [first!, ...rest], {error: (issue) => issue.code === 'invalid_union' ? selectionGuide(tool) : undefined});
}
const SELECTIONS = {entrypoints: selectionsFor('entrypoints'), callers: selectionsFor('callers'), impact: selectionsFor('impact')};

export function recoveryControlShapeFor(tool: Tool) {
  const selections = SELECTIONS[tool];
  return {select: selections.optional().describe('Evidence by public owner/coordinates; requires page; coverage unchanged.'), page: pageRequest.optional(), expect: z.string().regex(RESULT_IDENTITY_PATTERN).optional().describe('Assert full source resultIdentity; selection-independent; must agree with cursor.')};
}

/** The violated control constraint, typed by `constraint` and anchored at the control a caller must change. */
export type RecoveryControlIssue = {constraint: 'select-requires-page' | 'page-requires-select' | 'selection-shape' | 'page-shape' | 'kind-branch' | 'owner-branch'; path: (string | number)[]; message: string};

export function recoveryControlIssues(tool: Tool, args: {select?: unknown; page?: unknown; workspace?: unknown}): RecoveryControlIssue[] {
  if (args.select !== undefined && args.page === undefined) return [{constraint: 'select-requires-page', path: ['page'], message: 'select requires page with an explicit positive integer limit, e.g. {"limit":20}'}];
  if (args.select === undefined && args.page !== undefined) return [{constraint: 'page-requires-select', path: ['select'], message: 'page pages one selection and requires select'}];
  if (args.select === undefined) return [];
  const parsed = SELECTIONS[tool].safeParse(args.select);
  if (!parsed.success) return parsed.error.issues.map((issue) => ({constraint: 'selection-shape', path: ['select', ...issue.path.map((key) => typeof key === 'symbol' ? String(key) : key)], message: issue.message}));
  if (!pageRequest.safeParse(args.page).success) return [{constraint: 'page-shape', path: ['page'], message: 'page needs an explicit positive safe integer limit and an optional returned cursor'}];
  const workspace = args.workspace !== undefined;
  const branch = branchOf(tool, workspace);
  const s = parsed.data;
  const owners = branch[s.kind];
  const needs = workspace ? 'applies only without workspace' : 'requires workspace';
  if (owners === undefined) return [{constraint: 'kind-branch', path: ['select', 'kind'], message: `${s.kind} ${needs}`}];
  if ('owner' in s && !owners.includes(s.owner.kind)) return [{constraint: 'owner-branch', path: ['select', 'owner', 'kind'], message: `${s.kind} owner ${s.owner.kind} ${needs}; ${workspace ? 'with' : 'without'} workspace use ${list(owners)}`}];
  return [];
}

export function validRecoveryControls(tool: Tool, args: {select?: unknown; page?: unknown; workspace?: unknown}): boolean {
  return recoveryControlIssues(tool, args).length === 0;
}

/**
 * The published form of the same policy. The `select` property already admits only the tool's kind and owner pairs, so
 * each workspace branch restricts only its kinds and owners; a policy whose branch is not that product fails here.
 */
export function recoveryControlConstraintsFor(tool: Tool): CrossField {
  const pairing = {dependentRequired: {select: ['page'], page: ['select']}};
  const {local: localBranch, workspace: workspaceBranch} = ELIGIBILITY[tool];
  if (workspaceBranch === undefined) return pairing;
  const restrict = (branch: Branch) => {
    const kinds = KIND_ORDER.filter((kind) => branch[kind] !== undefined);
    const owners = [...new Set(kinds.flatMap((kind) => branch[kind]!))];
    for (const kind of kindsOf(tool)) for (const owner of ownersOf(tool, kind)) {
      if (kinds.includes(kind) && owners.includes(owner) && !branch[kind]!.includes(owner)) throw new Error(`${tool}: ${kind} ${owner} needs a pair constraint`);
    }
    const excludedKinds = kindsOf(tool).filter((kind) => !kinds.includes(kind));
    const excludedOwners = [...new Set(kindsOf(tool).flatMap((kind) => ownersOf(tool, kind)))].filter((owner) => !owners.includes(owner));
    return {properties: {select: {properties: {
      ...(excludedKinds.length ? {kind: {not: {enum: excludedKinds}}} : {}),
      ...(excludedOwners.length ? {owner: {properties: {kind: {not: {enum: excludedOwners}}}}} : {}),
    }}}};
  };
  return {...pairing, dependentSchemas: {workspace: restrict(workspaceBranch), select: {anyOf: [{required: ['workspace']}, restrict(localBranch)]}}};
}

/** Existing fact primitives are supplied by the adapter so projection provenance uses its established schema. */
export type SelectedOutputDeps = { recovery: z.ZodType; baseFact: {schema: z.ZodType; snapshot: z.ZodType; producer: z.ZodType; inputs: z.ZodType; evidence: z.ZodArray<z.ZodType>} };
export function selectedOutputFor(tool: Tool, deps: SelectedOutputDeps) {
  const {schema, snapshot, producer, inputs, evidence} = deps.baseFact;
  const analysis = z.discriminatedUnion('status', [z.strictObject({status:z.literal('complete')}), z.strictObject({status:z.literal('partial')}), z.strictObject({status:z.literal('unknown'), reason})]);
  const sourceFields = {schema, snapshot, producer, inputs, analysis};
  const source = z.strictObject({...sourceFields, reads:z.array(z.strictObject({owner:cutOwner,...sourceFields})), limits:z.array(z.strictObject({owner:cutOwner,kind:cutKind,cuts:index,places:index,limit:z.number().optional()}))});
  const handler = z.strictObject({path:z.string(),symbol:z.string(),line:z.number(),endLine:z.number().optional()});
  const identity = z.discriminatedUnion('kind', [
    z.strictObject({kind:z.literal('http-route'),name:z.string(),method:z.enum(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS','TRACE','ANY']),path:z.string(),version:z.string().optional(),handler}),
    z.strictObject({kind:z.literal('ui-route'),name:z.string(),path:z.string(),outlet:z.string().optional(),component:z.union([handler,z.literal('unknown')])}),
    z.strictObject({kind:z.literal('listener'),name:z.string(),protocol:z.enum(['kafka','rabbit','jms','event','nats']),destination:z.string(),handler}),
    z.strictObject({kind:z.literal('job'),name:z.string(),trigger:z.strictObject({attribute:z.string(),value:z.string()}),handler}),
    z.strictObject({kind:z.literal('callback'),name:z.string(),contract:z.strictObject({type:z.string(),member:z.string().optional()}),handler}),
  ]);
  const finding = z.discriminatedUnion('status', [z.strictObject({status:z.literal('complete'),identity}),z.strictObject({status:z.literal('unknown'),reason})]);
  const link = z.strictObject({id:z.string(),from:z.strictObject({repo:z.string(),file:z.string(),line:z.number(),symbol:z.string()}),to:z.strictObject({repo:z.string(),kind:z.enum(['http-route','ui-route','listener','job']),name:z.string(),handler}),transport:z.enum(['http','event']),basis:z.enum(['exact','base-path','suffix','event-destination','gateway-prefix','route-overlap']),profiles:z.array(z.string()).optional(),confidence:z.number()});
  const moduleVia = z.strictObject({file:z.string(),line:z.number(),specifier:z.string(),kind:z.enum(['import','reexport']),typeOnly:z.boolean(),form:z.enum(['dynamic-import','type-query']).optional()});
  const categories = [
    {select:handlerSelection, context:z.strictObject({owner:impactOwner,snapshot,handler,matchedEntrypointCount:index,interpretation:z.literal('recorded-origin-union')}), item:z.strictObject({seedIndex:index,seed:z.strictObject({file:z.string(),symbol:z.string(),line:z.number(),endLine:z.number().optional(),basis:z.enum(['lines','top-level','resource','requested'])})})},
    {select:moduleSelection, context:z.strictObject({owner:impactOwner,snapshot,module:z.strictObject({file:z.string(),snapshot:z.enum(['base','head']),depth:z.number(),via:moduleVia.optional()}),originCount:index}), item:z.strictObject({originIndex:index,origin:z.strictObject({file:z.string(),change:z.enum(['added','modified','deleted'])})})},
    {select:findingSelection, context:z.strictObject({findingIndex:index,section:analysis,finding}), item:z.strictObject({evidenceIndex:index,evidence:evidence.element})},
    {select:cutSelection, context:z.strictObject({owner:cutOwner,snapshot,analysis,cutIndex:index,kind:cutKind,reason:z.enum(CUT_REASONS),subReason:z.enum(CUT_SUB_REASONS).optional(),dependency:dependencyDiagnostic.optional(),anchor:z.string(),limit:z.number().optional()}), item:z.strictObject({atIndex:positive,place:z.string()})},
    {select:linkSelection, context:z.strictObject({link,direction:z.enum(['upstream','downstream']),reachCount:index,endpoints:z.strictObject({from:z.strictObject({snapshot,analysis}),to:z.strictObject({snapshot,analysis})})}), item:z.union([z.strictObject({position:index,linkId:z.string(),link}),z.strictObject({position:index,linkId:z.string(),unavailable:z.literal(true)})])},
  ];
  const allowed = tool === 'entrypoints' ? categories.slice(2,4) : tool === 'callers' ? [categories[0]!,categories[3]!,categories[4]!] : [categories[0]!,categories[1]!,categories[3]!,categories[4]!];
  const page = z.strictObject({limit:positive,offset:index,returned:index,total:index,nextCursor:z.string().optional()});
  const common = {text:z.string(),projectionSchema:z.literal(1),source,recovery:deps.recovery};
  const branches = allowed.flatMap(({select,context,item}) => [
    z.strictObject({...common,kind:z.literal('projection'),select,availability:z.literal('available'),context,items:z.array(item),page}),
    z.strictObject({...common,kind:z.literal('projection'),select,availability:z.literal('unavailable'),reason,evidence}),
    z.strictObject({...common,kind:z.literal('projection-receipt'),select,availability:z.literal('available'),page}),
    z.strictObject({...common,kind:z.literal('projection-receipt'),select,availability:z.literal('unavailable'),reason}),
  ]);
  const union = z.union([branches[0]!, branches[1]!, ...branches.slice(2)]);
  const json = z.toJSONSchema(union, {target: 'draft-7'});
  return z.looseObject({}).refine((value) => union.safeParse(value).success).meta({anyOf: json.anyOf});
}
