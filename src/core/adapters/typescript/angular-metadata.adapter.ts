import { posix } from "node:path";
import ts from "typescript";
import { isTypeScriptSource } from "../../domain/languages/typescript.ts";
import type { AngularClass, Operand, TemplateSource } from "../../domain/relations/angular-class.ts";
import type { FieldOrigin } from "../../domain/relations/field-origin.ts";
import { relation, type Relation, type SymbolRef } from "../../domain/relations/relation.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Evidence, Finding, UnknownReason } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { AngularMetadata, AngularMetadataReader } from "../../ports/angular-metadata.port.ts";
import { readAngularMetadataFile, type RawAngularClass, type RawAngularFile, type RawOperand, type RawReference, type RawTemplate, type RawText } from "./angular-metadata.extractor.ts";
import { readAngularRouteFile, type RawRouteFile } from "./angular-router.extractor.ts";
import { createDeclarationLookup } from "./declaration-lookup.ts";
import { angularProjects, pathsByProject } from "./angular-projects.ts";
import { createModuleResolver } from "./module-resolver.ts";

const ANGULAR_CORE = "@angular/core";

/**
 * The Angular classes and injection relations of each project (the directory of a `package.json` that names
 * `@angular/core`): every TypeScript source outside tests that belongs to it is parsed once and nothing is built or run. A name resolves through imports, renames
 * and barrels to the class that declares it; an installed package's class is not a relation of the repository.
 */
export function createAngularMetadataReader(): AngularMetadataReader {
  return { read: async (files) => readMetadata(files) };
}

interface Parsed {
  shape: RawRouteFile;
  angular: RawAngularFile;
}

/** What a name comes down to: a class, an array of operands, a declared value that is not a class (an `InjectionToken`), a member of one, or nothing usable. */
type Placed = { class: SymbolRef } | { array: { key: string; file: string; operands: readonly RawOperand[] } } | { token: SymbolRef } | { member: true } | { external: true } | { unresolved: true };

async function readMetadata(files: readonly SourceFile[]): Promise<AngularMetadata> {
  const contents = new Map(files.map((file) => [file.path, file.content]));
  const { byProject, orphaned } = pathsByProject([...contents.keys()].filter(isTypeScriptSource).sort(), files, ANGULAR_CORE);
  const classes: AngularClass[] = [];
  const findings: Finding<Relation>[] = orphaned.map((path) => unknown("no-project", { path, line: 1 }));
  const fields: FieldOrigin[] = [];
  for (const [project, sources] of byProject) {
    const metadata = await readProject(contents, project.dependencies, sources);
    classes.push(...metadata.classes);
    findings.push(...metadata.findings);
    fields.push(...metadata.fields);
  }
  return {
    classes: classes.sort((a, b) => (a.ref.path < b.ref.path ? -1 : a.ref.path > b.ref.path ? 1 : a.ref.line - b.ref.line)),
    findings,
    fields: fields.sort((a, b) => compareText(a.owner.path, b.owner.path) || a.owner.line - b.owner.line || compareText(a.field, b.field)),
  };
}

async function readProject(contents: ReadonlyMap<string, string>, dependencies: ReadonlySet<string>, sources: readonly string[]): Promise<AngularMetadata> {
  const read = async (path: string): Promise<string | undefined> => contents.get(path);
  const resolver = createModuleResolver(read, dependencies);
  const parsed = new Map<string, Promise<Parsed | undefined>>();
  const parse = (file: string): Promise<Parsed | undefined> => {
    let held = parsed.get(file);
    if (held === undefined) {
      held = (async () => {
        const source = await read(file);
        if (source === undefined) return undefined;
        const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const shape = readAngularRouteFile(sf);
        return shape === undefined ? undefined : { shape, angular: readAngularMetadataFile(sf, shape) };
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
      const placed = await resolve(file, target.reference);
      const from = { path: file, symbol: owner.name, line: owner.line };
      /* A token is a declaration of the repository like any other: what it injects is a dependence the walk can follow. */
      const to = "class" in placed ? placed.class : "token" in placed ? placed.token : undefined;
      if (to !== undefined) {
        const key = `${from.path}\0${from.symbol}\0${to.path}\0${to.symbol}`;
        if (!injects.has(key)) injects.set(key, { status: "complete", value: relation("injects", from, to), evidence: [at] });
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
  for (const file of sources) {
    for (const reference of (await parse(file))?.angular.substituted ?? []) {
      const holds = await originOf(file, reference);
      if (holds !== undefined) substituted.add(holdsKey(holds));
    }
  }
  const fields: FieldOrigin[] = [];
  for (const file of sources) {
    for (const raw of (await parse(file))?.angular.fields ?? []) {
      if ("opaque" in raw.target) continue;
      const holds = await originOf(file, raw.target.reference);
      if (holds === undefined || (raw.via === "inject" && substituted.has(holdsKey(holds)))) continue;
      fields.push({ owner: { path: file, symbol: raw.owner.name, line: raw.owner.line }, field: raw.field, holds });
    }
  }
  return { classes, findings: [...findings, ...injects.values()], fields };
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
