import { posix } from "node:path";
import ts from "typescript";
import { sourceTree } from "./source-tree.ts";
import { isTypeScriptSource } from "../../domain/languages/typescript.ts";
import type { AngularClass, Operand, TemplateSource } from "../../domain/relations/angular-class.ts";
import type { MemberProofContext, MemberUseOrigin } from "../../domain/relations/member-use.ts";
import type { FieldOrigin, LocalOrigin } from "../../domain/relations/field-origin.ts";
import { relation, type Relation, type SymbolRef } from "../../domain/relations/relation.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Evidence, Finding, UnknownReason } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { AngularMetadata, AngularMetadataReader } from "../../ports/angular-metadata.port.ts";
import { readAngularMetadataFile, type RawAngularClass, type RawAngularFile, type RawInstanceMethod, type RawInjection, type RawOperand, type RawReference, type RawTemplate, type RawText } from "./angular-metadata.extractor.ts";
import { readAngularRouteFile, type RawRouteFile } from "./angular-router.extractor.ts";
import { createDeclarationLookup } from "./declaration-lookup.ts";
import { manifestsOf, pathsByProject, projectOf } from "./angular-projects.ts";
import { createModuleResolver } from "./module-resolver.ts";

const ANGULAR_CORE = "@angular/core";

/**
 * The Angular classes and injection relations of each project (the directory of a `package.json` that names
 * `@angular/core`): every TypeScript source outside tests that belongs to it is parsed once and nothing is built or run. A name resolves through imports, renames
 * and barrels to the class that declares it; an installed package's class is not a relation of the repository.
 */
export function createAngularMetadataReader(): AngularMetadataReader {
  return { read: async (files, options) => readMetadata(files, options?.memberProofs) };
}

interface Parsed {
  shape: RawRouteFile;
  angular: RawAngularFile;
}

/** What a name comes down to: a class, an array of operands, a declared value that is not a class (an `InjectionToken`), a member of one, or nothing usable. */
type Placed = { class: SymbolRef } | { array: { key: string; file: string; operands: readonly RawOperand[] } } | { token: SymbolRef } | { member: true } | { external: true } | { unresolved: true };

async function readMetadata(files: readonly SourceFile[], proof?: MemberProofContext): Promise<AngularMetadata> {
  const contents = new Map(files.map((file) => [file.path, file]));
  const sourcePaths = [...contents.keys()].filter(isTypeScriptSource).sort();
  const { byProject, orphaned } = pathsByProject(sourcePaths, files, ANGULAR_CORE);
  const classes: AngularClass[] = [];
  const findings: Finding<Relation>[] = orphaned.map((path) => unknown("no-project", { path, line: 1 }));
  const fields: FieldOrigin[] = [];
  const locals: LocalOrigin[] = [];
  const memberUses: MemberUseOrigin[] = [];
  const manifests = manifestsOf(files);
  for (const [project, sources] of byProject) {
    const complete = proof?.completeSource === true && byProject.size === 1 && contents.size === files.length && orphaned.length === 0 && sources.length === sourcePaths.length && sources.every((path) => projectOf(path, manifests)?.directory === project.directory);
    const metadata = await readProject(contents, project.dependencies, sources, complete, proof !== undefined);
    classes.push(...metadata.classes);
    findings.push(...metadata.findings);
    fields.push(...metadata.fields);
    locals.push(...metadata.locals);
    memberUses.push(...(metadata.memberUses ?? []));
  }
  return {
    classes: classes.sort((a, b) => (a.ref.path < b.ref.path ? -1 : a.ref.path > b.ref.path ? 1 : a.ref.line - b.ref.line)),
    findings,
    fields: fields.sort((a, b) => compareText(a.owner.path, b.owner.path) || a.owner.line - b.owner.line || compareText(a.field, b.field)),
    locals: locals.sort((a, b) => compareText(a.owner.path, b.owner.path) || a.owner.line - b.owner.line || compareText(a.local, b.local)),
    ...(proof === undefined ? {} : { memberUses }),
  };
}

async function readProject(contents: ReadonlyMap<string, SourceFile>, dependencies: ReadonlySet<string>, sources: readonly string[], proveMembers: boolean, collectSites: boolean): Promise<AngularMetadata> {
  const read = async (path: string): Promise<string | undefined> => contents.get(path)?.content;
  const resolver = createModuleResolver(read, dependencies);
  const sourceSet = new Set(sources);
  const parsed = new Map<string, Promise<Parsed | undefined>>();
  const parse = (file: string): Promise<Parsed | undefined> => {
    let held = parsed.get(file);
    if (held === undefined) {
      held = (async () => {
        const source = await read(file);
        if (source === undefined) return undefined;
        const sf = sourceTree(contents.get(file)!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const shape = readAngularRouteFile(sf);
        if (shape === undefined) return undefined;
        const usesCore = [...shape.imports.values()].some((binding) => binding.module === ANGULAR_CORE);
        const coreExternal = usesCore && "external" in await resolver.resolve(file, ANGULAR_CORE);
        return { shape, angular: readAngularMetadataFile(sf, shape, collectSites, coreExternal) };
      })();
      parsed.set(file, held);
    }
    return held;
  };
  const fileOf = async (from: string, specifier: string): Promise<string | undefined> => {
    const resolution = await resolver.resolve(from, specifier);
    return "file" in resolution ? resolution.file : undefined;
  };
  const declarationOf = createDeclarationLookup(async (file) => (await parse(file))?.shape, fileOf);
  const proofDeclarationOf = createDeclarationLookup(async (file) => {
    const source = await parse(file);
    if (!sourceSet.has(file) || source === undefined || [...source.shape.imports.keys()].some((name) => source.angular.memberEvidence.declarations.has(name))) return undefined;
    return source.shape;
  }, fileOf);

  const place = async (file: string, name: string): Promise<Placed> => {
    const target = await parse(file);
    const span = target?.shape.declared.get(name);
    if (target === undefined || span === undefined) return { unresolved: true };
    if (target.shape.classes.has(name)) return { class: { path: file, symbol: name, line: span.line } };
    const operands = target.angular.arrays.get(name);
    return operands === undefined ? { token: { path: file, symbol: name, line: span.line } } : { array: { key: `${file}\0${name}`, file, operands } };
  };
  const through = async (from: string, module: string, imported: string): Promise<Placed> => {
    const resolution = await resolver.resolve(from, module);
    if ("external" in resolution) return { external: true };
    if (!("file" in resolution)) return { unresolved: true };
    const declaration = await declarationOf(resolution.file, imported);
    return declaration === undefined ? { unresolved: true } : place(declaration.file, declaration.name);
  };
  const resolve = async (file: string, reference: RawReference): Promise<Placed> => {
    const here = await parse(file);
    if (here === undefined) return { unresolved: true };
    const bound = here.shape.imports.get(reference.name);
    if (reference.member !== undefined && bound?.imported === "*") return through(file, bound.module, reference.member);
    const head = here.shape.declared.has(reference.name) ? await place(file, reference.name) : bound === undefined ? { unresolved: true as const } : await through(file, bound.module, bound.imported);
    /* A member of a class, an enum or an object is a value whose own span this read does not know. */
    return reference.member !== undefined && !("unresolved" in head) && !("external" in head) ? { member: true } : head;
  };
  const stableRoot = (source: Parsed, reference: RawReference): boolean => {
    const count = source.angular.memberEvidence.declarations.get(reference.name) ?? 0;
    return source.shape.imports.has(reference.name) ? count === 0 : !source.shape.declared.has(reference.name) || count === 1;
  };
  const operandsOf = async (file: string, raws: readonly RawOperand[], trail: ReadonlySet<string> = new Set()): Promise<Operand[]> => {
    const operands: Operand[] = [];
    for (const raw of raws) {
      const at = { path: file, line: raw.line };
      if ("unreadable" in raw) {
        operands.push({ unresolved: at });
        continue;
      }
      const placed = await resolve(file, raw.reference);
      if ("class" in placed) operands.push({ ref: placed.class, at });
      else if ("array" in placed && !trail.has(placed.array.key)) operands.push(...(await operandsOf(placed.array.file, placed.array.operands, new Set(trail).add(placed.array.key))));
      else if (!("external" in placed)) operands.push({ unresolved: at });
    }
    return operands;
  };

  const templateOf = (file: string, template: RawTemplate | undefined): TemplateSource | undefined => {
    if (template === undefined) return undefined;
    if ("inline" in template) return { inline: template.inline };
    const at = { path: file, line: template.line };
    return "unreadable" in template ? { unreadable: at } : { file: { path: posix.normalize(posix.join(posix.dirname(file), template.url)), at } };
  };
  const classOf = async (file: string, raw: RawAngularClass): Promise<AngularClass> => {
    const ref = { path: file, symbol: raw.name, line: raw.line };
    const selector = textOf(raw.selector);
    const hostDirectives = await operandsOf(file, raw.hostDirectives);
    switch (raw.kind) {
      case "component": {
        const template = templateOf(file, raw.template);
        return { kind: "component", ref, ...(selector !== undefined ? { selector } : {}), ...(template !== undefined ? { template } : {}), imports: await operandsOf(file, raw.imports), hostDirectives };
      }
      case "directive":
        return { kind: "directive", ref, ...(selector !== undefined ? { selector } : {}), hostDirectives };
      case "pipe": {
        const name = textOf(raw.pipeName);
        return { kind: "pipe", ref, ...(name !== undefined ? { name } : {}) };
      }
      case "module":
        return { kind: "module", ref, declarations: await operandsOf(file, raw.declarations), imports: await operandsOf(file, raw.imports), exports: await operandsOf(file, raw.exports) };
    }
  };

  const classes: AngularClass[] = [];
  const findings: Finding<Relation>[] = [];
  const injects = new Map<string, Finding<Relation>>();
  const pendingLocals = new Map<string, LocalOrigin>();
  for (const file of sources) {
    const source = await parse(file);
    if (source === undefined) {
      findings.push(unknown("source-unreadable", { path: file, line: 1 }));
      continue;
    }
    for (const raw of source.angular.classes) {
      for (const text of [raw.selector, raw.pipeName]) if (text !== undefined && "unreadable" in text) findings.push(unknown("unresolved", { path: file, line: text.line }));
      classes.push(await classOf(file, raw));
    }
    for (const injection of [...source.angular.injections].sort((a, b) => a.line - b.line)) {
      const at = { path: file, line: injection.line };
      const { owner, target } = injection;
      if (owner === undefined || "opaque" in target) {
        findings.push(unknown("no-extractor", at));
        continue;
      }
      if (!stableRoot(source, target.reference)) {
        findings.push(unknown("unresolved", at));
        continue;
      }
      const placed = await resolve(file, target.reference);
      const from = { path: file, symbol: owner.name, line: owner.line };
      /* A token is a declaration of the repository like any other: what it injects is a dependence the walk can follow. */
      const to = "class" in placed ? placed.class : "token" in placed ? placed.token : undefined;
      if (to !== undefined) {
        const key = `${from.path}\0${from.symbol}\0${to.path}\0${to.symbol}`;
        if (!injects.has(key)) injects.set(key, { status: "complete", value: relation("injects", from, to), evidence: [at] });
        if ("class" in placed && injection.local !== undefined) {
          const localKey = `${key}\0${injection.local}`;
          if (!pendingLocals.has(localKey)) pendingLocals.set(localKey, { owner: from, local: injection.local, holds: { class: placed.class } });
        }
      } else if (!("external" in placed)) findings.push(unknown("unresolved" in placed ? "unresolved" : "no-extractor", at));
    }
  }
  const originOf = async (file: string, reference: RawReference): Promise<FieldOrigin["holds"] | undefined> => {
    const placed = await resolve(file, reference);
    if ("class" in placed) return { class: placed.class };
    const here = await parse(file);
    const bound = here?.shape.imports.get(reference.name);
    if ("external" in placed && bound !== undefined) return { external: `${bound.module}#${bound.imported === "*" ? (reference.member ?? "*") : bound.imported}` };
    const global = "unresolved" in placed && here !== undefined && bound === undefined && reference.member === undefined && !here.shape.declared.has(reference.name);
    return global ? { external: `global#${reference.name}` } : undefined;
  };
  const substituted = new Set<string>();
  let unknownSubstitution = false;
  for (const file of sources) {
    const providerSource = await parse(file);
    for (const reference of providerSource?.angular.substituted ?? []) {
      const binding = providerSource?.shape.imports.has(reference.name);
      const count = providerSource?.angular.memberEvidence.declarations.get(reference.name) ?? 0;
      if (collectSites && (binding ? count !== 0 : count !== 1)) unknownSubstitution = true;
      const holds = await originOf(file, reference);
      if (holds !== undefined) substituted.add(holdsKey(holds));
      else unknownSubstitution = true;
    }
  }
  const fields: FieldOrigin[] = [];
  for (const file of sources) {
    const source = await parse(file);
    for (const raw of source?.angular.fields ?? []) {
      if ("opaque" in raw.target) continue;
      if (raw.via === "inject" && !stableRoot(source!, raw.target.reference)) continue;
      const holds = await originOf(file, raw.target.reference);
      if (holds === undefined || (raw.via === "inject" && substituted.has(holdsKey(holds)))) continue;
      fields.push({ owner: { path: file, symbol: raw.owner.name, line: raw.owner.line }, field: raw.field, holds });
    }
  }
  const locals = [...pendingLocals.values()].filter((candidate) => !substituted.has(holdsKey(candidate.holds)));
  const localSites = new Map<RawInjection, NonNullable<RawInjection["inlineMember"]>[]>();
  if (collectSites) {
    for (const file of sources) {
      const source = await parse(file);
      if (source === undefined) continue;
      const evidence = source.angular.memberEvidence;
      if (evidence.unknownBinding) continue;
      const calls = Map.groupBy(evidence.localCalls, (call) => call.local);
      for (const injection of source.angular.injections) {
        const { owner, local, localScope, target } = injection;
        if (owner === undefined || local === undefined || localScope === undefined || "opaque" in target || source.shape.imports.has(local) || evidence.declarations.get(local) !== 1 || evidence.declarations.get(owner.name) !== 1 || source.shape.declared.get(owner.name)?.line !== owner.line || !stableRoot(source, target.reference)) continue;
        const uses = (calls.get(local) ?? []).filter((call) => call.owner.name === owner.name && call.owner.line === owner.line && call.offset >= localScope.start && call.offset < localScope.end);
        if (evidence.reads.get(local) !== uses.length) continue;
        const placed = await resolve(file, target.reference);
        if (!("class" in placed) || substituted.has(holdsKey(placed))) continue;
        const origin = locals.find((candidate) => candidate.owner.path === file && candidate.owner.line === owner.line && candidate.owner.symbol === owner.name && candidate.local === local && holdsKey(candidate.holds) === holdsKey(placed));
        if (origin === undefined) continue;
        const admitted = uses.map((call) => ({ name: call.member, line: call.line, column: call.column, referenceName: `${local}.${call.member}` }));
        localSites.set(injection, admitted);
        if (admitted.length > 0) origin.calls = admitted.map((call) => ({ file, line: call.line, column: call.column, name: call.referenceName, kind: "calls" }));
      }
    }
  }
  const memberUses: MemberUseOrigin[] = [];
  if (proveMembers && !unknownSubstitution) {
    const parsedSources = await Promise.all(sources.map(parse));
    if (parsedSources.every((source) => source !== undefined && !source.angular.memberEvidence.unknownProvider)) {
      const unsafe = new Set(parsedSources.flatMap((source) => [...source!.angular.memberEvidence.unsafeMembers]));
      const unknownMutation = parsedSources.some((source) => source!.angular.memberEvidence.unknownMutation);
      const fieldsByOwner = Map.groupBy(fields, (field) => `${field.owner.path}\0${field.owner.line}\0${field.field}`);
      const resolvedImports = new Map<string, Promise<{ file: string; name: string } | undefined>>();
      const methodsByFile = new Map<string, ReadonlyMap<string, readonly RawInstanceMethod[]>>();
      const memberOf = async (file: string, source: Parsed, reference: RawReference, receiver: SymbolRef, name: string): Promise<SymbolRef | undefined> => {
        const evidence = source.angular.memberEvidence;
        const root = reference.name;
        const imported = source.shape.imports.has(root);
        if (unknownMutation || unsafe.has(name) || (imported ? evidence.declarations.has(root) : evidence.declarations.get(root) !== 1)) return undefined;
        if (imported) {
          const binding = source.shape.imports.get(root)!;
          const importedName = binding.imported === "*" ? reference.member : binding.imported;
          if (importedName === undefined) return undefined;
          const importKey = JSON.stringify([file, binding.module, importedName]);
          let pending = resolvedImports.get(importKey);
          if (pending === undefined) {
            pending = (async () => {
              const from = await fileOf(file, binding.module);
              return from === undefined ? undefined : proofDeclarationOf(from, importedName);
            })();
            resolvedImports.set(importKey, pending);
          }
          const declaration = await pending;
          if (declaration?.file !== receiver.path || declaration.name !== receiver.symbol) return undefined;
        }
        if (substituted.has(holdsKey({ class: receiver })) || !sourceSet.has(receiver.path)) return undefined;
        const target = await parse(receiver.path);
        if (target === undefined || target.angular.memberEvidence.declarations.get(receiver.symbol) !== 1 || target.angular.memberEvidence.escapedClasses.has(`${receiver.symbol}\0${receiver.line}`)) return undefined;
        let indexed = methodsByFile.get(receiver.path);
        if (indexed === undefined) {
          indexed = Map.groupBy(target.angular.memberEvidence.methods, (method) => `${method.className}\0${method.classLine}\0${method.name}`);
          methodsByFile.set(receiver.path, indexed);
        }
        const methods = indexed.get(`${receiver.symbol}\0${receiver.line}\0${name}`) ?? [];
        return methods.length === 1 ? { path: receiver.path, symbol: name, line: methods[0]!.line } : undefined;
      };
      for (const file of sources) {
        const source = (await parse(file))!;
        const evidence = source.angular.memberEvidence;
        const rawFieldsByOwner = Map.groupBy(source.angular.fields, (field) => `${field.owner.line}\0${field.owner.name}\0${field.field}`);
        const angularShadow = [...source.shape.imports].some(([name, binding]) => binding.module === ANGULAR_CORE && evidence.declarations.has(name));
        for (const call of evidence.calls) {
          if (evidence.declarations.get(call.owner.name) !== 1) continue;
          const candidates = fieldsByOwner.get(`${file}\0${call.owner.line}\0${call.field}`) ?? [];
          const rawFields = rawFieldsByOwner.get(`${call.owner.line}\0${call.owner.name}\0${call.field}`) ?? [];
          if (candidates.length !== 1 || rawFields.length !== 1 || unsafe.has(call.field)) continue;
          const field = candidates[0]!;
          const raw = rawFields[0]!;
          if (!("class" in field.holds) || "opaque" in raw.target || (raw.via === "inject" && angularShadow)) continue;
          const receiver = field.holds.class;
          const member = await memberOf(file, source, raw.target.reference, receiver, call.member);
          if (member !== undefined) memberUses.push({ owner: field.owner, receiver, member, reference: { file, line: call.line, column: call.column, name: `this.${call.field}.${call.member}`, kind: "calls" } });
        }
        for (const injection of source.angular.injections) {
          const { owner, inlineMember, target } = injection;
          if (owner === undefined || "opaque" in target || evidence.declarations.get(owner.name) !== 1 || source.shape.declared.get(owner.name)?.line !== owner.line) continue;
          const calls = inlineMember === undefined ? [] : [inlineMember];
          calls.push(...(localSites.get(injection) ?? []));
          if (calls.length === 0) continue;
          const placed = await resolve(file, target.reference);
          if (!("class" in placed)) continue;
          for (const call of calls) {
            const member = await memberOf(file, source, target.reference, placed.class, call.name);
            if (member !== undefined) memberUses.push({ owner: { path: file, symbol: owner.name, line: owner.line }, receiver: placed.class, member, reference: { file, line: call.line, column: call.column, name: call.referenceName, kind: "calls" } });
          }
        }
      }
    }
  }
  return { classes, findings: [...findings, ...injects.values()], fields, locals, ...(proveMembers ? { memberUses } : {}) };
}

function holdsKey(holds: FieldOrigin["holds"]): string {
  return "class" in holds ? `${holds.class.path}#${holds.class.symbol}` : holds.external;
}

function textOf(text: RawText | undefined): string | undefined {
  return text !== undefined && "text" in text ? text.text : undefined;
}

function unknown(reason: UnknownReason, at: Evidence): Finding<never> {
  return { status: "unknown", reason, evidence: [at] };
}
