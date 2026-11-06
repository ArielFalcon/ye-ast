import { dependencyDiagnostic } from "./dependency-schema.ts";
import { z } from 'zod';
import { RESULT_IDENTITY_PATTERN } from './evidence-cursor.ts';

type Tool = 'entrypoints' | 'callers' | 'impact';
const index = z.int().nonnegative();
const positive = z.int().positive();
const reason = z.enum(['no-extractor','no-project','out-of-scope','index-unavailable','source-unreadable','unresolved','revision-unavailable','deadline']);
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
const pageRequest = z.strictObject({limit: positive.describe('Explicit positive safe integer counting primary records; no default page size.'), cursor: z.string().optional().describe('Returned nextCursor for the same selection and limit; source identity is verified again.')});

const ORIGIN_OWNER = '{"kind":"local"} or {"kind":"section","repo":<id>}';
const HANDLER_SHAPE = `{"kind":"handler-origins","owner":${ORIGIN_OWNER},"handler":{"path","symbol","line"}}`;
const MODULE_SHAPE = `{"kind":"module-origins","owner":${ORIGIN_OWNER},"module":{"file","snapshot":"base"|"head"}}`;
const FINDING_SHAPE = '{"kind":"entrypoint-evidence","findingIndex"}';
const CUT_SHAPE = '{"kind":"cut-places","owner":{"kind":"fact"} or {"kind":"entrypoints"} or {"kind":"section","repo"} or {"kind":"read","repo","index"},"cutIndex"}';
const LINK_SHAPE = '{"kind":"workspace-link-evidence","linkId"}';
const shapes = (...accepted: string[]) => ({error: `select must be one of ${accepted.join('; ')}. Copy a lookup example from a previous answer.`});
const SELECTIONS = {
  entrypoints: z.union([findingSelection, cutSelection], shapes(FINDING_SHAPE, CUT_SHAPE)),
  callers: z.union([handlerSelection, cutSelection, linkSelection], shapes(HANDLER_SHAPE, CUT_SHAPE, LINK_SHAPE)),
  impact: z.union([handlerSelection, moduleSelection, cutSelection, linkSelection], shapes(HANDLER_SHAPE, MODULE_SHAPE, CUT_SHAPE, LINK_SHAPE)),
};

export function recoveryControlShapeFor(tool: Tool) {
  const selections = SELECTIONS[tool];
  return {select: selections.optional().describe('Recorded evidence selected by its public owner and coordinates; requires page and does not change analysis coverage.'), page: pageRequest.optional(), expect: z.string().regex(RESULT_IDENTITY_PATTERN).optional().describe('Assert the complete public source resultIdentity, with or without selection. Must agree with a supplied cursor.')};
}

export function validRecoveryControls(tool: Tool, args: {select?: unknown; page?: unknown; workspace?: unknown}): boolean {
  if ((args.select === undefined) !== (args.page === undefined)) return false;
  if (args.select === undefined) return true;
  const parsed = selection.safeParse(args.select);
  if (!parsed.success || !pageRequest.safeParse(args.page).success) return false;
  const s = parsed.data;
  if (tool === 'entrypoints') return s.kind === 'entrypoint-evidence' || (s.kind === 'cut-places' && (s.owner.kind === 'fact' || s.owner.kind === 'entrypoints'));
  const workspace = args.workspace !== undefined;
  if (s.kind === 'handler-origins' || s.kind === 'module-origins') return (s.kind !== 'module-origins' || tool === 'impact') && s.owner.kind === (workspace ? 'section' : 'local');
  if (s.kind === 'cut-places') return s.owner.kind === 'fact' || (workspace && (s.owner.kind === 'section' || s.owner.kind === 'read'));
  return s.kind === 'workspace-link-evidence' && workspace;
}

export function recoveryControlConstraintsFor(tool: Tool): object[] {
  const owner = (kinds: string[]) => ({ properties: { owner: { properties: {kind: {enum: kinds}}, required: ['kind'] } }, required: ['owner'] });
  const kind = (name: string, owners?: string[]) => ({ properties: { kind: {const: name}, ...(owners ? owner(owners).properties : {}) }, required: owners ? ['kind','owner'] : ['kind'] });
  const entries = [kind('entrypoint-evidence'), kind('cut-places', ['fact','entrypoints'])];
  const branches = (workspace: boolean) => [kind('handler-origins', [workspace ? 'section' : 'local']), ...(tool === 'impact' ? [kind('module-origins', [workspace ? 'section' : 'local'])] : []), kind('cut-places', workspace ? ['fact','section','read'] : ['fact']), ...(workspace ? [kind('workspace-link-evidence')] : [])];
  const restrict = (choices: object[]) => ({properties: {select: {anyOf: choices}}});
  return [
    {if: {required: ['select']}, then: {required: ['page']}},
    {if: {required: ['page']}, then: {required: ['select']}},
    ...(tool === 'entrypoints' ? [restrict(entries)] : [{if: {required: ['workspace']}, then: restrict(branches(true)), else: restrict(branches(false))}]),
  ];
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
  ]);
  const finding = z.discriminatedUnion('status', [z.strictObject({status:z.literal('complete'),identity}),z.strictObject({status:z.literal('unknown'),reason})]);
  const link = z.strictObject({id:z.string(),from:z.strictObject({repo:z.string(),file:z.string(),line:z.number(),symbol:z.string()}),to:z.strictObject({repo:z.string(),kind:z.enum(['http-route','ui-route','listener','job']),name:z.string(),handler}),transport:z.enum(['http','event']),basis:z.enum(['exact','base-path','suffix','operation-id','event-destination','gateway-prefix','route-overlap']),profiles:z.array(z.string()).optional(),confidence:z.number()});
  const moduleVia = z.strictObject({file:z.string(),line:z.number(),specifier:z.string(),kind:z.enum(['import','reexport']),typeOnly:z.boolean(),form:z.enum(['dynamic-import','type-query']).optional()});
  const categories = [
    {select:handlerSelection, context:z.strictObject({owner:impactOwner,snapshot,handler,matchedEntrypointCount:index,interpretation:z.literal('recorded-origin-union')}), item:z.strictObject({seedIndex:index,seed:z.strictObject({file:z.string(),symbol:z.string(),line:z.number(),endLine:z.number().optional(),basis:z.enum(['lines','top-level','resource','requested'])})})},
    {select:moduleSelection, context:z.strictObject({owner:impactOwner,snapshot,module:z.strictObject({file:z.string(),snapshot:z.enum(['base','head']),depth:z.number(),via:moduleVia.optional()}),originCount:index}), item:z.strictObject({originIndex:index,origin:z.strictObject({file:z.string(),change:z.enum(['added','modified','deleted'])})})},
    {select:findingSelection, context:z.strictObject({findingIndex:index,section:analysis,finding}), item:z.strictObject({evidenceIndex:index,evidence:evidence.element})},
    {select:cutSelection, context:z.strictObject({owner:cutOwner,snapshot,analysis,cutIndex:index,kind:cutKind,reason:reason.optional(),dependency:dependencyDiagnostic.optional(),anchor:z.string(),limit:z.number().optional()}), item:z.strictObject({atIndex:positive,place:z.string()})},
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
