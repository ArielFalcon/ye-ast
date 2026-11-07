import { posix } from "node:path";
import ts from "typescript";
import { sourceTree } from "./source-tree.ts";
import { bindFile } from "./lexical-bindings.ts";
import { unwrapped } from "./syntax.ts";
import { ANGULAR_CORE } from "./angular-injection.ts";
import { TYPESCRIPT_LIB_GLOBALS } from "./typescript-lib-globals.ts";
import { isAngularWorkspace, isTypeScriptSource } from "../../domain/languages/typescript.ts";
import type { AngularClass, Operand, TemplateSource } from "../../domain/relations/angular-class.ts";
import type { ExternalMemberUseOrigin, MemberProofContext, MemberSubstitute, MemberUseOrigin } from "../../domain/relations/member-use.ts";
import type { FieldOrigin, LocalOrigin } from "../../domain/relations/field-origin.ts";
import { relation, type Relation, type SymbolRef } from "../../domain/relations/relation.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Evidence, Finding, UnknownReason } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { TemplateEffects } from "../../ports/template-usage.port.ts";
import type { AngularMetadata, AngularMetadataReader, AngularMetadataReadOptions } from "../../ports/angular-metadata.port.ts";
import { readAngularMetadataFile, type RawAngularClass, type RawAngularFile, type RawInstanceMethod, type RawInjection, type RawOperand, type RawReference, type RawTemplate, type RawText, type RawWrite } from "./angular-metadata.extractor.ts";
import { readAngularRouteFile, type RawRouteFile } from "./angular-router.extractor.ts";
import { createDeclarationLookup } from "./declaration-lookup.ts";
import { manifestsOf, pathsByProject, projectOf } from "./angular-projects.ts";
import { createModuleResolver, type ManifestPackages } from "./module-resolver.ts";
import { providerIdentityEvidence, type ProviderIdentityEvidence } from "./provider-identity.ts";

const NO_PROVIDER_IDENTITY: ProviderIdentityEvidence = {
  tokens: new Set(), exportedTokens: new Set(), imports: new Map(), writes: new Set(),
};

/**
 * The Angular classes and injection relations of each project (the directory of a `package.json` that names
 * `@angular/core`): every TypeScript source outside tests that belongs to it is parsed once and nothing is built or run. A name resolves through imports, renames
 * and barrels to the class that declares it; an installed package's class is not a relation of the repository.
 */
export function createAngularMetadataReader(): AngularMetadataReader {
  return { read: async (files, options) => readMetadata(files, options?.memberProofs, options?.templateEffects) };
}

interface Parsed {
  shape: RawRouteFile;
  angular: RawAngularFile;
  identity: ProviderIdentityEvidence;
}

/** What a name comes down to: a class, an array of operands, a declared value that is not a class (an `InjectionToken`), a member of one, or nothing usable. */
type Placed = { class: SymbolRef } | { array: { key: string; file: string; operands: readonly RawOperand[] } } | { token: SymbolRef } | { member: true } | { external: true } | { unresolved: true };

async function readMetadata(files: readonly SourceFile[], proof?: MemberProofContext, templateEffects?: AngularMetadataReadOptions["templateEffects"]): Promise<AngularMetadata> {
  const contents = new Map(files.map((file) => [file.path, file]));
  const sourcePaths = [...contents.keys()].filter(isTypeScriptSource).sort();
  const { byProject, orphaned } = pathsByProject(sourcePaths, files, ANGULAR_CORE);
  const classes: AngularClass[] = [];
  const findings: Finding<Relation>[] = orphaned.map((path) => unknown("no-project", { path, line: 1 }));
  const fields: FieldOrigin[] = [];
  const locals: LocalOrigin[] = [];
  const memberUses: MemberUseOrigin[] = [];
  const externalUses: ExternalMemberUseOrigin[] = [];
  const manifests = manifestsOf(files);
  const replaced = replacedFiles(files);
  for (const [project, sources] of byProject) {
    const scope = proof?.completeSource === true && contents.size === files.length
      ? { sites: new Set(sources.filter((path) => projectOf(path, manifests)?.directory === project.directory)), evidence: sourcePaths, ...(replaced === undefined ? {} : { replaced }) }
      : undefined;
    const metadata = await readProject(contents, project.packages, sources, scope, proof !== undefined, templateEffects);
    classes.push(...metadata.classes);
    findings.push(...metadata.findings);
    fields.push(...metadata.fields);
    locals.push(...metadata.locals);
    memberUses.push(...(metadata.memberUses ?? []));
    externalUses.push(...(metadata.externalUses ?? []));
  }
  return {
    classes: classes.sort((a, b) => (a.ref.path < b.ref.path ? -1 : a.ref.path > b.ref.path ? 1 : a.ref.line - b.ref.line)),
    findings,
    fields: fields.sort((a, b) => compareText(a.owner.path, b.owner.path) || a.owner.line - b.owner.line || compareText(a.field, b.field)),
    locals: locals.sort((a, b) => compareText(a.owner.path, b.owner.path) || a.owner.line - b.owner.line || compareText(a.local, b.local)),
    ...(proof === undefined ? {} : { memberUses, externalUses }),
  };
}

/**
 * Where proofs may sit (the sources of the project's own manifest), every source whose writes and providers can reach
 * them, and the files an Angular workspace replaces at build time; `replaced` is absent when a workspace file is unreadable.
 */
interface ProofScope {
  sites: ReadonlySet<string>;
  evidence: readonly string[];
  replaced?: ReadonlySet<string>;
}

/** Every `fileReplacements` source the Angular workspaces name, relative to the repository; undefined when one cannot be read. */
function replacedFiles(files: readonly SourceFile[]): ReadonlySet<string> | undefined {
  const replaced = new Set<string>();
  for (const file of files.filter(({ path }) => isAngularWorkspace(path))) {
    let workspace: unknown;
    try {
      workspace = JSON.parse(file.content);
    } catch {
      return undefined;
    }
    const pending = [workspace];
    for (let value = pending.pop(); value !== undefined; value = pending.pop()) {
      if (typeof value !== "object" || value === null) continue;
      for (const [key, nested] of Object.entries(value)) {
        if (key !== "fileReplacements") {
          pending.push(nested);
          continue;
        }
        if (!Array.isArray(nested)) return undefined;
        for (const entry of nested) {
          const source = (entry as { replace?: unknown } | null)?.replace;
          if (typeof source !== "string") return undefined;
          replaced.add(posix.join(posix.dirname(file.path), source));
        }
      }
    }
  }
  return replaced;
}

async function readProject(contents: ReadonlyMap<string, SourceFile>, packages: ManifestPackages, sources: readonly string[], scope: ProofScope | undefined, collectSites: boolean, templateEffects?: AngularMetadataReadOptions["templateEffects"]): Promise<AngularMetadata> {
  const proveMembers = scope !== undefined;
  const read = async (path: string): Promise<string | undefined> => contents.get(path)?.content;
  const resolver = createModuleResolver(read, packages);
  const sourceSet = new Set(sources);
  const parsed = new Map<string, Promise<Parsed | undefined>>();
  const parse = (file: string): Promise<Parsed | undefined> => {
    let held = parsed.get(file);
    if (held === undefined) {
      held = (async () => {
        const source = await read(file);
        if (source === undefined) return undefined;
        const sf = sourceTree(contents.get(file)!, ts.ScriptTarget.Latest, ts.ScriptKind.TS);
        const shape = readAngularRouteFile(sf);
        if (shape === undefined) return undefined;
        const usesCore = [...shape.imports.values()].some((binding) => binding.module === ANGULAR_CORE);
        const coreExternal = usesCore && "external" in await resolver.resolve(file, ANGULAR_CORE);
        const angular = readAngularMetadataFile(sf, shape, collectSites, coreExternal);
        return { shape, angular, identity: proveMembers ? providerIdentityEvidence(sf, coreExternal, angular.memberEvidence.declarations) : NO_PROVIDER_IDENTITY };
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
    return "unreadable" in template ? { unreadable: at } : { file: { path: posix.join(posix.dirname(file), template.url), at } };
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
  const distinctToken = async (file: string, reference: RawReference): Promise<boolean> => {
    const source = await parse(file);
    if (source === undefined || !stableRoot(source, reference) || source.identity.writes.has(reference.name)) return false;
    const binding = source.identity.imports.get(reference.name);
    if (binding === undefined) return reference.member === undefined && source.identity.tokens.has(reference.name);
    const name = binding.imported === "*" ? reference.member : reference.member === undefined ? binding.imported : undefined;
    if (name === undefined) return false;
    const from = await fileOf(file, binding.module);
    const declaration = from === undefined ? undefined : await proofDeclarationOf(from, name);
    const target = declaration === undefined ? undefined : await parse(declaration.file);
    return declaration !== undefined && target !== undefined && target.identity.exportedTokens.has(declaration.name) && !target.identity.writes.has(declaration.name) && target.angular.memberEvidence.declarations.get(declaration.name) === 1;
  };
  for (const file of sources) {
    for (const { reference } of (await parse(file))?.angular.substituted ?? []) {
      const holds = await originOf(file, reference);
      if (holds !== undefined) substituted.add(holdsKey(holds));
    }
  }
  const fields: FieldOrigin[] = [];
  const proofFields: FieldOrigin[] = [];
  for (const file of sources) {
    const source = await parse(file);
    for (const raw of source?.angular.fields ?? []) {
      if ("opaque" in raw.target) continue;
      if (raw.via === "inject" && !stableRoot(source!, raw.target.reference)) continue;
      const holds = await originOf(file, raw.target.reference);
      if (holds === undefined) continue;
      const field = { owner: { path: file, symbol: raw.owner.name, line: raw.owner.line }, field: raw.field, holds };
      proofFields.push(field);
      if (raw.via !== "inject" || !substituted.has(holdsKey(holds))) fields.push(field);
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
  /**
   * What can change a proof's receiver or member, read from every evidence source and kept with what it reaches: a class
   * and one member, a class and all of its members, or a member name on any class when the written object is not placed.
   * A provider replaces only the class it provides, and a known substitute class qualifies the proof instead of refusing it.
   * An object or a token the reader cannot place reaches every class its file names, and the file that declares the token.
   * A mutation API used as a value, a replaced export of an installed package (every token it constructs could become any
   * class) and an unreadable source have no bound, and then nothing is proven.
   */
  const effectsByComponent = new Map<AngularClass, TemplateEffects | undefined>();
  const effectsOf = (component: Extract<AngularClass, { kind: "component" }>): TemplateEffects | undefined => {
    if (!effectsByComponent.has(component)) effectsByComponent.set(component, templateEffects?.(component));
    return effectsByComponent.get(component);
  };
  async function risksOf({ evidence, replaced }: ProofScope): Promise<{ reaches: (receiver: SymbolRef, member: string) => boolean; substitutesOf: (receiver: SymbolRef) => readonly MemberSubstitute[] | undefined } | undefined> {
    const parsedEvidence = await Promise.all(evidence.map(async (file) => ({ file, source: await parse(file) })));
    if (replaced === undefined || parsedEvidence.some(({ source }) => source === undefined || source.angular.memberEvidence.escapedMutator)) return undefined;
    let unbounded = false;
    const classKey = (ref: SymbolRef): string => `${ref.path}\0${ref.symbol}\0${ref.line}`;
    const unsafe = new Set<string>();
    const names = new Set<string>();
    const substitutes = new Map<string, MemberSubstitute[]>();
    const reach = (ref: SymbolRef, member?: string): void => { unsafe.add(`${classKey(ref)}\0${member ?? "*"}`); };
    const fieldsByOwner = Map.groupBy(proofFields, (field) => `${field.owner.path}\0${field.owner.line}\0${field.field}`);
    const namedByFile = new Map<string, Promise<SymbolRef[]>>();
    const namedClasses = (file: string, source: Parsed): Promise<SymbolRef[]> => {
      let named = namedByFile.get(file);
      if (named === undefined) {
        named = (async () => {
          const references = [...[...source.shape.imports.keys()].map((name) => ({ name })), ...source.angular.memberEvidence.qualified, ...[...source.shape.classes].map((name) => ({ name }))];
          const placed = await Promise.all(references.map((reference) => resolve(file, reference)));
          return placed.flatMap((place) => ("class" in place ? [place.class] : []));
        })();
        namedByFile.set(file, named);
      }
      return named;
    };
    /** Set once members no syntax names are written on an object the syntax does not place: it may be any instance passed on. */
    let opaque = false;
    const unplaced = async (file: string, source: Parsed, member?: string): Promise<void> => {
      if (member !== undefined) return void names.add(member);
      opaque = true;
      for (const ref of await namedClasses(file, source)) reach(ref);
    };
    const place = async (file: string, source: Parsed, write: RawWrite): Promise<void> => {
      const { target, member } = write;
      if ("unplaced" in target) return unplaced(file, source, member);
      if ("self" in target) return reach({ path: file, symbol: target.self.name, line: target.self.line }, member);
      if ("field" in target) {
        const held = fieldsByOwner.get(`${file}\0${target.field.owner.line}\0${target.field.field}`) ?? [];
        const holds = held.length === 1 ? held[0]!.holds : undefined;
        return holds !== undefined && "class" in holds ? reach(holds.class, member) : unplaced(file, source, member);
      }
      if ("prototype" in target) {
        const placed = await resolve(file, target.prototype);
        if ("class" in placed) return reach(placed.class, member);
        return "external" in placed || "token" in placed || "array" in placed ? undefined : unplaced(file, source, member);
      }
      const namespace = target.binding.member === undefined && source.shape.imports.get(target.binding.name)?.imported === "*";
      const placed = await resolve(file, namespace && member !== undefined ? { name: target.binding.name, member } : target.binding);
      if ("class" in placed) return target.whole === true || namespace ? reach(placed.class) : undefined;
      if ("external" in placed) {
        if (target.whole === true || namespace) unbounded = true;
        return undefined;
      }
      if (target.whole === true && !("unresolved" in placed)) return undefined;
      return unplaced(file, source, namespace ? undefined : member);
    };
    for (const { file, source } of parsedEvidence) {
      const parsedSource = source!;
      const evidenceOf = parsedSource.angular.memberEvidence;
      for (const write of evidenceOf.writes) await place(file, parsedSource, write);
      if (evidenceOf.unknownProvider) await unplaced(file, parsedSource);
      for (const substitution of parsedSource.angular.substituted) {
        const { reference } = substitution;
        const count = evidenceOf.declarations.get(reference.name) ?? 0;
        if (collectSites && (parsedSource.shape.imports.has(reference.name) ? count !== 0 : count !== 1)) await unplaced(file, parsedSource);
        const holds = await originOf(file, reference);
        if (holds === undefined) {
          if (await distinctToken(file, reference)) continue;
          await unplaced(file, parsedSource);
          const placed = await resolve(file, reference);
          const declaring = "token" in placed ? placed.token.path : "array" in placed ? placed.array.file : undefined;
          const declared = declaring === undefined || declaring === file ? undefined : await parse(declaring);
          if (declared !== undefined) await unplaced(declaring!, declared);
          continue;
        }
        if (!("class" in holds)) continue;
        const by = substitution.by === undefined ? undefined : await resolve(file, substitution.by);
        if (by === undefined || !("class" in by)) reach(holds.class);
        else substitutes.set(classKey(holds.class), [...(substitutes.get(classKey(holds.class)) ?? []), { class: by.class, at: { path: file, line: substitution.line } }]);
      }
    }
    /**
     * A subclass member reaches that member on every class above the subclass, whose code may read it on a subclass
     * instance; a base it cannot place makes them unsafe on every class. A constructor above it that may return another object
     * leaves the subclass's own instances unknown.
     */
    const subclasses = parsedEvidence.flatMap(({ file, source }) => source!.angular.memberEvidence.subclasses.map((subclass) => ({ file, source: source!, subclass })));
    const byClass = new Map<string, (typeof subclasses)[number]>(subclasses.flatMap((entry) => (entry.subclass.name === undefined ? [] : [[`${entry.file}\0${entry.subclass.name}\0${entry.subclass.line}`, entry] as const])));
    for (const { file, source, subclass } of subclasses) {
      const visited = new Set<string>();
      let at: { file: string; base?: RawReference | "platform" } | undefined = { file, ...(subclass.base === undefined ? {} : { base: subclass.base }) };
      const self = subclass.name === undefined ? undefined : { path: file, symbol: subclass.name, line: subclass.line };
      while (at !== undefined) {
        const placed: Placed = at.base === "platform" ? { external: true } : at.base === undefined ? { unresolved: true } : await resolve(at.file, at.base);
        if (!("class" in placed)) {
          if (!("external" in placed)) for (const member of subclass.members) await unplaced(file, source, member);
          break;
        }
        const ancestor = placed.class;
        if (visited.has(classKey(ancestor))) break;
        visited.add(classKey(ancestor));
        for (const member of subclass.members) reach(ancestor, member);
        if (self !== undefined && (await parse(ancestor.path))?.angular.memberEvidence.escapedClasses.has(`${ancestor.symbol}\0${ancestor.line}`) !== false) reach(self);
        const above = byClass.get(classKey(ancestor));
        at = above === undefined ? undefined : { file: above.file, ...(above.subclass.base === undefined ? {} : { base: above.subclass.base }) };
      }
    }
    /** A build may swap a replaced file for another, so every class it exports may be another class there. */
    const exportedClasses = async (file: string, seen: Set<string>): Promise<SymbolRef[]> => {
      const source = await parse(file);
      if (seen.has(file) || source === undefined) return [];
      seen.add(file);
      const exported = await Promise.all([...source.shape.exports.values()].map(async (entry): Promise<SymbolRef[]> => {
        if ("local" in entry) {
          const placed = await resolve(file, { name: entry.local });
          return "class" in placed ? [placed.class] : [];
        }
        const placed = await through(file, entry.module, entry.imported);
        return "class" in placed ? [placed.class] : [];
      }));
      const starred = await Promise.all(source.shape.stars.map(async (module) => {
        const target = await fileOf(file, module);
        return target === undefined ? [] : exportedClasses(target, seen);
      }));
      return [...exported, ...starred].flat();
    };
    for (const file of evidence.filter((path) => replaced.has(path))) for (const ref of await exportedClasses(file, new Set())) reach(ref);
    const passedOn = parsedEvidence.flatMap(({ file, source }) => source!.angular.memberEvidence.passed.map((passed) => ({ file, passed })));
    /** A template's writes and passed fields are its component's own; a template that does not parse may do anything with them. */
    for (const component of classes) {
      if (component.kind !== "component") continue;
      const file = component.ref.path;
      const source = await parse(file);
      const done = effectsOf(component);
      if (source === undefined || done === undefined) continue;
      const owner = { name: component.ref.symbol, line: component.ref.line };
      if (done.unreadable === true) {
        for (const field of proofFields) if (field.owner.path === file && field.owner.line === owner.line && "class" in field.holds) reach(field.holds.class);
        continue;
      }
      for (const write of done.writes) {
        const target = "component" in write.target ? { self: owner } : "field" in write.target ? { field: { owner, field: write.target.field } } : { unplaced: true as const };
        await place(file, source, { target, ...(write.member === undefined ? {} : { member: write.member }), line: write.line });
      }
      passedOn.push(...done.passed.map((field) => ({ file, passed: { field: { owner, field } } })));
    }
    /** An instance its holder passes on can reach such a write wherever it lands, so its class proves none of its members. */
    if (opaque) {
      const hidden = new Set(parsedEvidence.flatMap(({ file, source }) => [...source!.angular.memberEvidence.hidden].map((key) => `${file}\0${key}`)));
      const fieldsNamed = Map.groupBy(proofFields.filter((field) => !hidden.has(`${field.owner.path}\0${field.owner.symbol}\0${field.owner.line}\0${field.field}`)), (field) => field.field);
      for (const { file, passed } of passedOn) {
        const held = "field" in passed ? fieldsByOwner.get(`${file}\0${passed.field.owner.line}\0${passed.field.field}`) ?? [] : "fieldNamed" in passed ? fieldsNamed.get(passed.fieldNamed) ?? [] : [];
        for (const field of held) if ("class" in field.holds) reach(field.holds.class);
        if ("instance" in passed) {
          const placed = await resolve(file, passed.instance);
          if ("class" in placed) reach(placed.class);
        }
      }
    }
    if (unbounded) return undefined;
    return {
      reaches: (receiver, member) => names.has(member) || unsafe.has(`${classKey(receiver)}\0${member}`) || unsafe.has(`${classKey(receiver)}\0*`),
      substitutesOf: (receiver) => substitutes.get(classKey(receiver))?.toSorted((a, b) => compareText(a.at.path, b.at.path) || a.at.line - b.at.line || compareText(a.class.path, b.class.path) || compareText(a.class.symbol, b.class.symbol)),
    };
  }
  const memberUses: MemberUseOrigin[] = [];
  const externalUses: ExternalMemberUseOrigin[] = [];
  const risks = scope === undefined ? undefined : await risksOf(scope);
  if (scope !== undefined && risks !== undefined) {
    const fieldsByOwner = Map.groupBy(proofFields, (field) => `${field.owner.path}\0${field.owner.line}\0${field.field}`);
    const resolvedImports = new Map<string, Promise<{ file: string; name: string } | undefined>>();
    const methodsByFile = new Map<string, ReadonlyMap<string, readonly RawInstanceMethod[]>>();
    const memberOf = async (file: string, source: Parsed, reference: RawReference, receiver: SymbolRef, name: string): Promise<{ member: SymbolRef; substitutes?: readonly MemberSubstitute[] } | undefined> => {
      const evidence = source.angular.memberEvidence;
      const root = reference.name;
      const imported = source.shape.imports.has(root);
      if (risks.reaches(receiver, name) || source.identity.writes.has(root) || (imported ? evidence.declarations.has(root) : evidence.declarations.get(root) !== 1)) return undefined;
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
      if (!sourceSet.has(receiver.path)) return undefined;
      const target = await parse(receiver.path);
      if (target === undefined || target.identity.writes.has(receiver.symbol) || target.angular.memberEvidence.declarations.get(receiver.symbol) !== 1 || target.angular.memberEvidence.escapedClasses.has(`${receiver.symbol}\0${receiver.line}`)) return undefined;
      let indexed = methodsByFile.get(receiver.path);
      if (indexed === undefined) {
        indexed = Map.groupBy(target.angular.memberEvidence.methods, (method) => `${method.className}\0${method.classLine}\0${method.name}`);
        methodsByFile.set(receiver.path, indexed);
      }
      const methods = indexed.get(`${receiver.symbol}\0${receiver.line}\0${name}`) ?? [];
      if (methods.length !== 1) return undefined;
      const substitutes = risks.substitutesOf(receiver);
      return { member: { path: receiver.path, symbol: name, line: methods[0]!.line }, ...(substitutes === undefined ? {} : { substitutes }) };
    };
    const proven = (owner: SymbolRef, receiver: SymbolRef, proof: { member: SymbolRef; substitutes?: readonly MemberSubstitute[] }, reference: MemberUseOrigin["reference"]): MemberUseOrigin =>
      ({ owner, receiver, member: proof.member, reference, ...(proof.substitutes === undefined ? {} : { substitutes: proof.substitutes }) });
    for (const file of sources) {
      if (!scope.sites.has(file)) continue;
      const source = (await parse(file))!;
      const evidence = source.angular.memberEvidence;
      const rawFieldsByOwner = Map.groupBy(source.angular.fields, (field) => `${field.owner.line}\0${field.owner.name}\0${field.field}`);
      const angularShadow = [...source.shape.imports].some(([name, binding]) => binding.module === ANGULAR_CORE && evidence.declarations.has(name));
      const proveFieldCall = async (call: { owner: { name: string; line: number }; field: string; member: string }, reference: MemberUseOrigin["reference"], template: boolean): Promise<void> => {
        if (evidence.declarations.get(call.owner.name) !== 1) return;
        const candidates = fieldsByOwner.get(`${file}\0${call.owner.line}\0${call.field}`) ?? [];
        const rawFields = rawFieldsByOwner.get(`${call.owner.line}\0${call.owner.name}\0${call.field}`) ?? [];
        if (candidates.length !== 1 || rawFields.length !== 1) return;
        const field = candidates[0]!;
        const raw = rawFields[0]!;
        if (risks.reaches(field.owner, call.field) || "opaque" in raw.target || (raw.via === "inject" && angularShadow) || (template && raw.via !== "inject")) return;
        if ("external" in field.holds) {
          const proven = field.holds.external.startsWith("global#") ? constructsLibraryGlobal(file, contents.get(file)?.content, call.owner, call.field) : raw.via !== "inject" || !substituted.has(holdsKey(field.holds));
          if (!template && proven) externalUses.push({ owner: field.owner, field: call.field, holds: field.holds.external, reference });
          return;
        }
        const receiver = field.holds.class;
        const proof = await memberOf(file, source, raw.target.reference, receiver, call.member);
        if (proof !== undefined) memberUses.push({ ...proven(field.owner, receiver, proof, reference), ...(template ? { template: true as const } : {}) });
      };
      for (const call of evidence.calls) await proveFieldCall(call, { file, line: call.line, column: call.column, name: `this.${call.field}.${call.member}`, kind: "calls" }, false);
      for (const component of classes) {
        if (component.kind !== "component" || component.ref.path !== file) continue;
        const owner = { name: component.ref.symbol, line: component.ref.line };
        if (evidence.escapedClasses.has(`${owner.name}\0${owner.line}`)) continue;
        for (const call of effectsOf(component)?.calls ?? []) await proveFieldCall({ owner, field: call.field, member: call.member }, { file: call.file, line: call.line, column: call.column, name: `${call.field}.${call.member}`, kind: "calls" }, true);
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
          const proof = await memberOf(file, source, target.reference, placed.class, call.name);
          if (proof !== undefined) memberUses.push(proven({ path: file, symbol: owner.name, line: owner.line }, placed.class, proof, { file, line: call.line, column: call.column, name: call.referenceName, kind: "calls" }));
        }
      }
    }
  }
  return { classes, findings: [...findings, ...injects.values()], fields, locals, ...(proveMembers ? { memberUses, externalUses } : {}) };
}

/**
 * Whether the field's initializer constructs a name that, by the binder (ADR-0029), binds nothing the file declares or
 * imports and is not in a dynamic scope, and that the language's libraries declare. The unresolved-name fallback of a
 * field origin proves neither: a generated or unavailable class is unresolved too.
 */
const LIBRARY_GLOBALS: ReadonlySet<string> = new Set(TYPESCRIPT_LIB_GLOBALS);

function constructsLibraryGlobal(path: string, content: string | undefined, owner: { name: string; line: number }, field: string): boolean {
  if (content === undefined) return false;
  const { tree, bindingOf } = bindFile(path, content);
  const initializers: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassLike(node) && node.name?.text === owner.name) {
      for (const member of node.members) if (ts.isPropertyDeclaration(member) && member.name.getText(tree) === field && member.initializer !== undefined) initializers.push(unwrapped(member.initializer));
    }
    node.forEachChild(visit);
  };
  visit(tree);
  const only = initializers.length === 1 ? initializers[0] : undefined;
  const name = only !== undefined && ts.isNewExpression(only) && ts.isIdentifier(only.expression) ? only.expression : undefined;
  return name !== undefined && LIBRARY_GLOBALS.has(name.text) && bindingOf(name).kind === "none";
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
