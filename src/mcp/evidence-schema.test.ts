import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { z } from 'zod';
import { CAPABILITY_ABSENT } from '../core/domain/shared/fact.ts';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';

const validator = (schema: unknown) => new AjvJsonSchemaValidator().getValidator(schema as Parameters<AjvJsonSchemaValidator['getValidator']>[0]);
import { recoveryControlShapeFor, validRecoveryControls, recoveryControlConstraintsFor, selectedOutputFor } from './evidence-schema.ts';

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

test('selected output requires concrete items and unavailable has no page', () => {
  const scalar = z.string();
  const schema = selectedOutputFor('entrypoints', { recovery: z.strictObject({ status: z.literal('available') }), baseFact: { schema: scalar, snapshot: z.strictObject({repo: scalar, kind: z.literal('sha'), sha: scalar}), producer: z.strictObject({name: scalar, version: scalar}), inputs: z.strictObject({}), evidence: z.array(z.strictObject({path: scalar, line: z.number()})) } });
  const source = { schema: '1', snapshot: {repo:'r',kind:'sha',sha:'s'}, producer: {name:'n',version:'v'}, inputs: {}, analysis: {status:'complete'}, reads: [], limits: [] };
  const common = { text: 'Selection', projectionSchema: 1, source, select: {kind:'entrypoint-evidence', findingIndex:0}, recovery: {status:'available'} };
  const available = { ...common, kind:'projection', availability:'available', context: {findingIndex:0, section:{status:'complete'}, finding:{status:'unknown',reason:'unresolved'}}, items:[{evidenceIndex:0,evidence:{path:'a',line:1}}], page:{limit:1,offset:0,returned:1,total:1} };
  assert.equal(schema.safeParse(available).success, true);
  for (const contract of [{ type: 'a.b.C', member: 'run' }, { type: 'a.b.C' }]) {
    const identity = { kind: 'callback', name: 'a.b.C.run', contract, handler: { path: 'callback.ts', symbol: 'Worker.run', line: 7 } };
    const callback = { ...available, context: { ...available.context, finding: { status: 'complete', identity } } };
    assert.equal(schema.safeParse(callback).success, true);
    assert.equal(schema.safeParse({ ...callback, context: { ...callback.context, finding: { status: 'complete', identity: { ...identity, contract: {} } } } }).success, false);
  }
  assert.equal(schema.safeParse({...available, items:[{evidenceIndex:0}]}).success, false);
  assert.equal(schema.safeParse({...common,kind:'projection',availability:'unavailable',reason:'unresolved',evidence:[]}).success, true);
  assert.equal(schema.safeParse({...common,kind:'projection',availability:'unavailable',evidence:[]}).success, false);
  assert.equal(schema.safeParse({...common,kind:'projection',availability:'unavailable',reason:'unresolved',evidence:[],page:{limit:1,offset:0,returned:0,total:0}}).success, false);
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

test('concrete categories and receipts validate in runtime and draft-7 schema', () => {
  const str = z.string();
  const snapSchema = z.strictObject({repo:str,kind:z.literal('sha'),sha:str});
  const schema = selectedOutputFor('impact',{recovery:z.strictObject({status:z.literal('available')}),baseFact:{schema:str,snapshot:snapSchema,producer:z.strictObject({name:str,version:str}),inputs:z.strictObject({}),evidence:z.array(z.strictObject({path:str,line:z.number()}))}});
  const validate = validator(z.toJSONSchema(schema,{target:'draft-7'}));
  const snap = {repo:'r',kind:'sha',sha:'x'}, analysis = {status:'complete'};
  const source = {schema:'1',snapshot:snap,producer:{name:'n',version:'v'},inputs:{},analysis,reads:[],limits:[]};
  const page = {limit:1,offset:0,returned:1,total:1};
  const h = {path:'a',symbol:'h',line:3,endLine:4};
  const link = {id:'id',from:{repo:'r',file:'a',line:1,symbol:'x'},to:{repo:'r',kind:'job',name:'j',handler:h},transport:'event',basis:'exact',confidence:1};
  const cases = [
    {select:{kind:'handler-origins',owner:{kind:'local'},handler:{path:'a',symbol:'h',line:3}},context:{owner:{kind:'local'},snapshot:snap,handler:h,matchedEntrypointCount:1,interpretation:'recorded-origin-union'},item:{seedIndex:1,seed:{file:'a',symbol:'x',line:1,basis:'requested'}}},
    {select:{kind:'module-origins',owner:{kind:'local'},module:{file:'a',snapshot:'base'}},context:{owner:{kind:'local'},snapshot:snap,module:{file:'a',snapshot:'base',depth:1},originCount:1},item:{originIndex:2,origin:{file:'a',change:'deleted'}}},
    {select:{kind:'cut-places',owner:{kind:'fact'},cutIndex:0},context:{owner:{kind:'fact'},snapshot:snap,analysis,cutIndex:0,kind:'unresolved-link',reason:'dependency-unresolved',dependency:{name:'com.acme:clients',reason:'ambiguous',candidates:['one','two']},anchor:'a'},item:{atIndex:1,place:'b'}},
    {select:{kind:'cut-places',owner:{kind:'fact'},cutIndex:0},context:{owner:{kind:'fact'},snapshot:snap,analysis,cutIndex:0,kind:'unresolved-link',reason:'dispatch',subReason:'capability-absent',anchor:'a'},item:{atIndex:1,place:'b'}},
    {select:{kind:'workspace-link-evidence',linkId:'id'},context:{link,direction:'upstream',reachCount:1,endpoints:{from:{snapshot:snap,analysis},to:{snapshot:snap,analysis}}},item:{position:0,linkId:'lost',unavailable:true}},
  ];
  for (const c of cases) {
    const common = {text:'Selection',projectionSchema:1,source,recovery:{status:'available'},select:c.select};
    const value = {...common,kind:'projection',availability:'available',context:c.context,items:[c.item],page};
    const receipt = {...common,kind:'projection-receipt',availability:'available',page};
    for (const [candidate, expected] of [[value,true],[receipt,true],[{...value,items:[{}]},false],[{...receipt,items:[]},false],[{...common,kind:'projection-receipt',availability:'unavailable',reason:'unresolved'},true]] as const) {
      assert.equal(schema.safeParse(candidate).success, expected);
      assert.equal(validate(candidate).valid, expected);
    }
  }
});

test('entrypoint identities retain UI component and unknown finding evidence in both schema forms', () => {
  const s = z.string();
  const snapshot = z.strictObject({repo:s,kind:z.literal('sha'),sha:s});
  const schema = selectedOutputFor('entrypoints',{recovery:z.strictObject({status:z.literal('available')}),baseFact:{schema:s,snapshot,producer:z.strictObject({name:s,version:s}),inputs:z.strictObject({}),evidence:z.array(z.strictObject({path:s,line:z.number()}))}});
  const validate = validator(z.toJSONSchema(schema,{target:'draft-7'}));
  const source = {schema:'1',snapshot:{repo:'r',kind:'sha',sha:'s'},producer:{name:'n',version:'v'},inputs:{},analysis:{status:'partial'},reads:[],limits:[]};
  const value = {text:'Selection',kind:'projection',projectionSchema:1,source,recovery:{status:'available'},select:{kind:'entrypoint-evidence',findingIndex:0},availability:'available',context:{findingIndex:0,section:{status:'complete'},finding:{status:'unknown',reason:'unresolved'}},items:[{evidenceIndex:0,evidence:{path:'a',line:2}}],page:{limit:1,offset:0,returned:1,total:1}};
  const identities = [
    {kind:'ui-route',name:'n',path:'/a',outlet:'aux',component:'unknown'},
    {kind:'ui-route',name:'n',path:'/a',component:{path:'a',symbol:'C',line:3,endLine:5}},
    {kind:'job',name:'j',trigger:{attribute:'cron',value:'*'},handler:{path:'a',symbol:'h',line:1}},
  ];
  const accepted = [value,{...value,context:{...value.context,finding:{status:'unknown',reason:CAPABILITY_ABSENT}}},...identities.map(identity => ({...value,context:{...value.context,finding:{status:'complete',identity}}}))];
  const cases = [...accepted.map(candidate => [candidate,true] as const),[{...value,items:[{evidenceIndex:0}]},false] as const];
  for (const [candidate, expected] of cases) {
    assert.equal(schema.safeParse(candidate).success,expected);
    assert.equal(validate(candidate).valid,expected);
  }
});
