import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { z } from 'zod';
import { CAPABILITY_ABSENT } from '../core/domain/shared/fact.ts';
import { unresolvedCallSiteSchema } from './composition-schema-parts.ts';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';

const validator = (schema: unknown) => new AjvJsonSchemaValidator().getValidator(schema as Parameters<AjvJsonSchemaValidator['getValidator']>[0]);
import { recoveryControlShapeFor, validRecoveryControls, recoveryControlConstraintsFor, selectedOutputFor } from './evidence-schema.ts';

test('unresolved request schemas preserve method-only facts and reject unstated methods or undefined keys', () => {
  const site = { path: 'client.ts', line: 3, symbol: 'Client.send', transport: 'http', reason: 'unresolved', evidence: [] };
  const advertised = validator(z.toJSONSchema(unresolvedCallSiteSchema));
  for (const stated of [{ method: 'GET' }, { method: 'POST', path: '/orders' }, { method: 'GET', expressions: [[{ kind: 'unknown', cause: 'destination-undecidable', evidence: [{ path: 'config.ts', line: 9 }] }, { kind: 'text', text: '/orders/' }, { kind: 'runtime', encoded: true }]] }]) {
    assert.equal(unresolvedCallSiteSchema.safeParse({ ...site, stated }).success, true);
    assert.equal(advertised({ ...site, stated }).valid, true);
  }
  assert.equal(unresolvedCallSiteSchema.safeParse({ ...site, stated: { path: '/orders' } }).success, false);
  assert.equal(unresolvedCallSiteSchema.safeParse({ ...site, stated: { method: 'GET', path: undefined } }).success, false);
  assert.equal(unresolvedCallSiteSchema.safeParse({ ...site, stated: { method: 'GET', expressions: [[{ kind: 'unknown', cause: 'destination-undecidable' }]] } }).success, false);
});

test('control schemas enforce pairing, branches, safe integers and closed subjects', () => {
  for (const tool of ['entrypoints', 'callers', 'impact'] as const) {
    const schema = z.strictObject({ ...recoveryControlShapeFor(tool), workspace: z.object({}).optional() });
    const valid = (x: unknown) => { const r = schema.safeParse(x); return r.success && validRecoveryControls(tool, r.data); };
    assert.equal(valid({}), true);
    assert.equal(valid({ select: { kind: 'cut-places', owner: { kind: 'fact' }, cutIndex: 0 }, page: { limit: 1 } }), true);
    assert.equal(valid({ select: { kind: 'cut-places', owner: { kind: 'fact' }, cutIndex: 0 } }), false);
    assert.equal(valid({ page: { limit: 1 } }), false);
    assert.equal(valid({ select: { kind: 'cut-places', owner: { kind: 'fact' }, cutIndex: -1 }, page: { limit: 1 } }), false);
    assert.equal(valid({ select: { kind: 'cut-places', owner: { kind: 'fact', extra: 1 }, cutIndex: 0 }, page: { limit: 1 } }), false);
    assert.equal(valid({ select: { kind: 'cut-places', owner: { kind: 'fact' }, cutIndex: 0 }, page: { limit: Number.MAX_SAFE_INTEGER + 1 } }), false);
  }
  const module = { kind: 'module-origins', owner: { kind: 'local' }, module: { file: 'a', snapshot: 'base' } };
  assert.equal(validRecoveryControls('callers', { select: module, page: { limit: 1 } }), false);
  assert.equal(validRecoveryControls('impact', { select: module, page: { limit: 1 } }), true);
  assert.equal(validRecoveryControls('impact', { workspace: {}, select: module, page: { limit: 1 } }), false);
});

test('a selection receipt states its page only when available', () => {
  const scalar = z.string();
  const schema = selectedOutputFor('entrypoints', { recovery: z.strictObject({ status: z.literal('available') }), baseFact: { schema: scalar, snapshot: z.strictObject({repo: scalar, kind: z.literal('sha'), sha: scalar}), producer: z.strictObject({name: scalar, version: scalar}), inputs: z.strictObject({}) } });
  const source = { schema: '1', snapshot: {repo:'r',kind:'sha',sha:'s'}, producer: {name:'n',version:'v'}, inputs: {}, analysis: {status:'complete'}, reads: [], limits: [] };
  const common = { text: 'Selection', projectionSchema: 1, source, select: {kind:'entrypoint-evidence', findingIndex:0}, recovery: {status:'available'}, kind: 'projection-receipt' };
  const page = {limit:1,offset:0,returned:1,total:1};
  assert.equal(schema.safeParse({...common, availability:'available', page}).success, true);
  assert.equal(schema.safeParse({...common, availability:'unavailable', reason:'unresolved'}).success, true);
  assert.equal(schema.safeParse({...common, availability:'unavailable', reason:'unresolved', page}).success, false);
  assert.equal(schema.safeParse({...common, kind:'projection', availability:'available', page}).success, false);
});

test('advertised control constraints match runtime for each branch', () => {
  const handler = (owner: object) => ({kind:'handler-origins',owner,handler:{path:'a',symbol:'x',line:1}});
  const local = {kind:'local'}, section = {kind:'section',repo:'r'};
  const options = [
    {}, {expect:`mcp-r1:${'a'.repeat(64)}`}, {page:{limit:1}},
    {select:handler(local),page:{limit:1}}, {select:handler(section),page:{limit:1},workspace:{}},
    {select:handler(section),page:{limit:1}}, {select:handler(local),page:{limit:1},workspace:{}},
    {select:{kind:'module-origins',owner:local,module:{file:'a',snapshot:'head'}},page:{limit:1}},
    {select:{kind:'cut-places',owner:{kind:'read',repo:'r',index:1},cutIndex:0},page:{limit:1},workspace:{}},
    {select:{kind:'entrypoint-evidence',findingIndex:0},page:{limit:1}},
    {select:{kind:'workspace-link-evidence',linkId:'id'},page:{limit:1},workspace:{}},
    {select:{kind:'workspace-link-evidence',linkId:'id'},page:{limit:1}},
    {select:{kind:'cut-places',owner:{kind:'entrypoints'},cutIndex:0},page:{limit:1}},
    {select:{kind:'cut-places',owner:section,cutIndex:0},page:{limit:1}}, {select:{kind:'cut-places',owner:section,cutIndex:0},page:{limit:1},workspace:{}},
    {select:{kind:'module-origins',owner:section,module:{file:'a',snapshot:'base'}},page:{limit:1},workspace:{}},
    {select:handler(local),page:{limit:0}}, {select:handler(local),page:{limit:1,cursor:'x',extra:1}},
    {select:handler(local),page:{limit:9007199254740992}},
  ];
  for (const tool of ['entrypoints','callers','impact'] as const) {
    const base = z.strictObject({...recoveryControlShapeFor(tool),workspace:z.strictObject({}).optional()});
    const json = z.toJSONSchema(base,{target:'draft-2020-12'});
    const validate = validator({...json,...recoveryControlConstraintsFor(tool)});
    for (const value of options) {
      const result = base.safeParse(value);
      assert.equal(validate(value).valid, result.success && validRecoveryControls(tool,result.data), `${tool}: ${JSON.stringify(value)}`);
    }
  }
});

test('receipts validate the same in runtime and draft-7 schema for every selection a tool allows', () => {
  const str = z.string();
  const schema = selectedOutputFor('impact',{recovery:z.strictObject({status:z.literal('available')}),baseFact:{schema:str,snapshot:z.strictObject({repo:str,kind:z.literal('sha'),sha:str}),producer:z.strictObject({name:str,version:str}),inputs:z.strictObject({})}});
  const validate = validator(z.toJSONSchema(schema,{target:'draft-7'}));
  const source = {schema:'1',snapshot:{repo:'r',kind:'sha',sha:'x'},producer:{name:'n',version:'v'},inputs:{},analysis:{status:'complete'},reads:[],limits:[]};
  const page = {limit:1,offset:0,returned:1,total:1};
  const selects = [
    [{kind:'handler-origins',owner:{kind:'local'},handler:{path:'a',symbol:'h',line:3}}, true],
    [{kind:'module-origins',owner:{kind:'local'},module:{file:'a',snapshot:'base'}}, true],
    [{kind:'cut-places',owner:{kind:'fact'},cutIndex:0}, true],
    [{kind:'workspace-link-evidence',linkId:'id'}, true],
    [{kind:'entrypoint-evidence',findingIndex:0}, false],
  ] as const;
  for (const [select, allowed] of selects) {
    const common = {text:'Selection',projectionSchema:1,source,recovery:{status:'available'},select,kind:'projection-receipt'};
    for (const [candidate, expected] of [[{...common,availability:'available',page},allowed],[{...common,availability:'unavailable',reason:'unresolved'},allowed],[{...common,availability:'available',page,items:[]},false]] as const) {
      assert.equal(schema.safeParse(candidate).success, expected);
      assert.equal(validate(candidate).valid, expected);
    }
  }
});
