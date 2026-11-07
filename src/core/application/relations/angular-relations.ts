import { sortFindings } from "../../domain/entrypoints/finding-order.ts";
import { classKey, type AngularClass, type Operand } from "../../domain/relations/angular-class.ts";
import type { MemberUseOrigin, MemberProofContext } from "../../domain/relations/member-use.ts";
import type { FieldOrigin, LocalOrigin } from "../../domain/relations/field-origin.ts";
import { relation, type Relation, type SymbolRef } from "../../domain/relations/relation.ts";
import type { Evidence, Finding, UnknownReason } from "../../domain/shared/fact.ts";
import type { AngularMetadataReader } from "../../ports/angular-metadata.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ComponentTemplate, RelationExtraction, RelationExtractor } from "./relation-extractor.ts";
import type { ScopeMember, TemplateEffects, TemplateUnit, TemplateUsageReader } from "../../ports/template-usage.port.ts";

export interface AngularRelationsDeps {
  metadata: AngularMetadataReader;
  templates: TemplateUsageReader;
}

/**
 * The injection and template relations of an Angular repository: the injections the metadata reader found, the host
 * directives of each class, and for each component the components, directives and pipes its template uses, scoped by the
 * standalone `imports` of the component or by the declarations and imports of the NgModule that declares it. The
 * template files a `templateUrl` names are read from the sources given.
 */
export function createAngularRelationExtractor(deps: AngularRelationsDeps): RelationExtractor {
  return { extract: (files, options) => extractRelations(deps, files, options) };
}

async function extractRelations(deps: AngularRelationsDeps, files: readonly SourceFile[], options?: { memberProofs?: MemberProofContext }): Promise<RelationExtraction> {
  const contents = new Map(files.map((file) => [file.path, file.content]));
  const read = new Map<string, TemplateRead>();
  /** Each component's template read once, for the metadata reader's proofs and for its handlers alike. */
  const templateRead = (component: Extract<AngularClass, { kind: "component" }>): TemplateRead => {
    const key = classKey(component.ref);
    let done = read.get(key);
    if (done === undefined) {
      done = readTemplate(deps.templates, component, contents);
      read.set(key, done);
    }
    return done;
  };
  const templateEffects = (component: Extract<AngularClass, { kind: "component" }>): TemplateEffects => templateRead(component).effects;
  const { classes, findings, fields, locals, memberUses, externalUses } = await deps.metadata.read(files, { ...options, templateEffects });
  const { units, findings: unitFindings } = templateUnitsOf(classes, contents);
  const templates = classes.flatMap((candidate): ComponentTemplate[] => {
    if (candidate.kind !== "component") return [];
    const { effects, unreadable, lines } = templateRead(candidate);
    return [{ component: candidate.ref, ...(lines === undefined ? {} : { lines }), handlers: effects.handlers, ...(unreadable === undefined ? {} : { unreadable }) }];
  });
  return { relations: sortFindings([...findings, ...unitFindings, ...deps.templates.read(units)]), fields, locals, ...(memberUses === undefined ? {} : { memberUses }), ...(externalUses === undefined ? {} : { externalUses }), templates };
}

const NO_EFFECTS: TemplateEffects = { calls: [], handlers: [], writes: [], passed: [] };

interface TemplateRead {
  effects: TemplateEffects;
  lines?: ComponentTemplate["lines"];
  unreadable?: Evidence;
}

/** What a component's template does, and the place it cannot be read from: its own place, or where it names its file. */
function readTemplate(templates: TemplateUsageReader, component: Extract<AngularClass, { kind: "component" }>, contents: ReadonlyMap<string, string>): TemplateRead {
  const source = component.template === undefined ? undefined : templateOf(component, component.template, contents);
  if (source === undefined) return { effects: NO_EFFECTS };
  if ("unknown" in source) return { effects: { ...NO_EFFECTS, unreadable: true }, unreadable: source.unknown.evidence[0]! };
  const effects = templates.effects(source);
  const lines = { path: source.path, start: source.firstLine, end: source.firstLine + source.text.split("\n").length - 1 };
  return effects.unreadable === true ? { effects, lines, unreadable: { path: source.path, line: source.firstLine } } : { effects, lines };
}

/**
 * The template of each component with its scope, and the host-directive and unreadable-template findings met on the way.
 * A component whose template is missing or unreadable has no unit.
 */
export function templateUnitsOf(classes: readonly AngularClass[], contents: ReadonlyMap<string, string>): { units: TemplateUnit[]; findings: Finding<Relation>[] } {
  const byKey = new Map(classes.map((candidate) => [classKey(candidate.ref), candidate]));
  const declaredIn = new Map<string, Extract<AngularClass, { kind: "module" }>[]>();
  for (const candidate of classes) {
    if (candidate.kind !== "module") continue;
    for (const operand of candidate.declarations) {
      if ("ref" in operand) declaredIn.set(classKey(operand.ref), [...(declaredIn.get(classKey(operand.ref)) ?? []), candidate]);
    }
  }

  const found: Finding<Relation>[] = [];
  const units: TemplateUnit[] = [];
  for (const candidate of classes) {
    if (candidate.kind === "component" || candidate.kind === "directive") {
      for (const host of candidate.hostDirectives) {
        if ("unresolved" in host) found.push(unknown("unresolved", host.unresolved));
        else if (byKey.get(classKey(host.ref))?.kind === "directive") found.push({ status: "complete", value: relation("uses-directive", candidate.ref, host.ref), evidence: [host.at] });
      }
    }
    if (candidate.kind !== "component" || candidate.template === undefined) continue;
    const source = templateOf(candidate, candidate.template, contents);
    if ("unknown" in source) {
      found.push(source.unknown);
      continue;
    }
    const scope = scopeOf(candidate, byKey, declaredIn);
    for (const problem of scope.problems) found.push(unknown("unresolved", problem));
    units.push({ component: candidate.ref, ...source, scope: scope.members });
  }
  return { units, findings: found };
}

function templateOf(component: Extract<AngularClass, { kind: "component" }>, template: NonNullable<Extract<AngularClass, { kind: "component" }>["template"]>, contents: ReadonlyMap<string, string>): { path: string; text: string; firstLine: number } | { unknown: Finding<never> } {
  if ("unreadable" in template) return { unknown: unknown("no-extractor", template.unreadable) };
  if ("inline" in template) return { path: component.ref.path, text: template.inline.text, firstLine: template.inline.line };
  const text = contents.get(template.file.path);
  return text === undefined ? { unknown: unknown("source-unreadable", template.file.at) } : { path: template.file.path, text: text.replaceAll("\r\n", "\n"), firstLine: 1 };
}

interface Scope {
  members: ScopeMember[];
  /** Where a list that makes the scope could not be read: what it holds may be what the template uses. */
  problems: Evidence[];
}

function scopeOf(component: Extract<AngularClass, { kind: "component" }>, byKey: ReadonlyMap<string, AngularClass>, declaredIn: ReadonlyMap<string, readonly Extract<AngularClass, { kind: "module" }>[]>): Scope {
  const problems: Evidence[] = [];
  const classesOf = (operands: readonly Operand[], exported: boolean, trail: ReadonlySet<string> = new Set()): AngularClass[] =>
    operands.flatMap((operand) => {
      if ("unresolved" in operand) {
        problems.push(operand.unresolved);
        return [];
      }
      const target = byKey.get(classKey(operand.ref));
      if (target === undefined) return [];
      if (target.kind !== "module") return [target];
      const key = classKey(target.ref);
      return exported && trail.has(key) ? [] : classesOf(target.exports, true, new Set(trail).add(key));
    });

  const modules = declaredIn.get(classKey(component.ref)) ?? [];
  const [module] = modules;
  const reached: AngularClass[] = [];
  if (modules.length > 1) problems.push({ path: component.ref.path, line: component.ref.line });
  else if (module !== undefined) reached.push(...classesOf(module.declarations, false), ...classesOf(module.imports, false));
  else reached.push(...classesOf(component.imports, false));

  const members = new Map<string, ScopeMember>();
  for (const candidate of reached) {
    const key = classKey(candidate.ref);
    if (key === classKey(component.ref)) continue;
    const member = memberOf(candidate);
    if (member !== undefined) members.set(key, member);
  }
  return { members: [...members.values()], problems };
}

function memberOf(candidate: AngularClass): ScopeMember | undefined {
  if ((candidate.kind === "component" || candidate.kind === "directive") && candidate.selector !== undefined) return { kind: candidate.kind, ref: candidate.ref satisfies SymbolRef, selector: candidate.selector };
  if (candidate.kind === "pipe" && candidate.name !== undefined) return { kind: "pipe", ref: candidate.ref, name: candidate.name };
  return undefined;
}

function unknown(reason: UnknownReason, at: Evidence): Finding<never> {
  return { status: "unknown", reason, evidence: [at] };
}
