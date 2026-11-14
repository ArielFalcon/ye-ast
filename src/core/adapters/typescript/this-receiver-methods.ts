import ts from "typescript";
import { CAPABILITY_ABSENT } from "../../domain/shared/fact.ts";
import type { ImplementingSite, MethodPlace, OutsideSupertypes, ReceiverCallSite, ReceiverMethod } from "../../ports/import-origins.port.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { hasModifier, isStatic, lineOf, propertyNameText, thisClass } from "./syntax.ts";

/** What a heritage name stands for: the key of a library or package type, the repository declarations of one file it names, or nothing proven. */
export type HeritageProof = string | { file: string; declarations: readonly ts.Node[] } | undefined;

export interface ThisReceiverDeps {
  /** The tree of a TypeScript source of the snapshot; none for any other file. */
  treeOf(file: string): ts.SourceFile | undefined;
  /** The nodes that start at a call site's 1-based place. */
  nodesAt(file: string, site: ReceiverCallSite): readonly ts.Node[];
  /** A reader of what a heritage clause's expression written in `file` names, for one batch of sites. */
  heritage(): (file: string, expression: ts.Expression) => Promise<HeritageProof>;
  /** The TypeScript sources whose text may write a heritage clause. */
  heritageFiles(): readonly string[];
}

/** A site this reading does not read: the pack has no receiver reading for it. */
const UNKNOWN: ReceiverMethod = { kind: "unknown", reason: CAPABILITY_ABSENT };
const UNPROVEN: ReceiverMethod = { kind: "unproven" };
const UNKNOWN_SUPERTYPES: OutsideSupertypes = { kind: "unknown" };

/**
 * The receiver reading of a TypeScript call on `this` or `super` written in an instance member of a class declaration
 * (ADR-0090): the nearest declaration of the member's name in that class (for `super`, in the class above it) and up its
 * `extends` chain; an outside receiver of the one library or package type the chain ends at, written as a plain name
 * without type arguments, when no class of it declares the name and, for `this`, none below the class does, whose
 * declarations are otherwise the candidates of an `unproven` answer; `unproven` for any other chain: a heritage the sources
 * do not settle, an expression, type arguments, a class expression, an interface or namespace of a class's own name that
 * may add members, an index signature or a computed member name that may be the name, or overloads of mixed kinds. A
 * declaration is a method, accessor, property or constructor parameter property of the instance side, overloads by the
 * lines from the first to the last name. Every other site, `this` where it may denote anything but that instance
 * included, is `unknown` as `capability-absent`, the answer the pack gives where it has no receiver reading.
 */
export function createThisReceiverReading({ treeOf, nodesAt, heritage, heritageFiles }: ThisReceiverDeps): {
  receiverMethods(sites: readonly ReceiverCallSite[], signal?: AbortSignal): Promise<readonly ReceiverMethod[]>;
  outsideSupertypes(sites: readonly ImplementingSite[], signal?: AbortSignal): Promise<readonly OutsideSupertypes[]>;
} {
  let hierarchy: Promise<Hierarchy | undefined> | undefined;

  async function methodAt(site: ReceiverCallSite, heritageOf: ReturnType<typeof heritage>): Promise<ReceiverMethod> {
    if (treeOf(site.file) === undefined) return UNKNOWN;
    const access = nodesAt(site.file, site).map((node) => accessOf(node, site.member)).find((found) => found !== undefined);
    const keyword = access?.expression;
    const owner = keyword === undefined ? undefined : instanceClassOf(keyword);
    if (access === undefined || owner === undefined) return UNKNOWN;
    const viaSuper = keyword!.kind === ts.SyntaxKind.SuperKeyword;
    const seen = new Set<ts.Node>();
    let file = site.file;
    let cls: ts.ClassDeclaration = owner;
    for (let own = !viaSuper; ; own = true) {
      if (seen.has(cls)) return UNPROVEN;
      seen.add(cls);
      if (own) {
        const declared = declaredMember(cls, site.member);
        if (declared === "open") return UNPROVEN;
        if (declared !== undefined && declared.abstract) return implementationsBelow(file, cls, site.member);
        if (declared !== undefined) return { kind: "method", file, start: declared.start, nameLine: declared.nameLine, ...(viaSuper ? { exact: true as const } : {}) };
        if (mergesOwnName(cls)) return UNPROVEN;
      }
      const written = cls.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
      if (written === undefined || (written.typeArguments?.length ?? 0) > 0) return UNPROVEN;
      const proven = await heritageOf(file, written.expression);
      if (typeof proven === "string") {
        if (viaSuper) return { kind: "outside", type: proven, exact: true };
        const below = await implementationsBelow(site.file, owner, site.member);
        return below.kind === "unproven" && below.candidates?.length === 0 ? { kind: "outside", type: proven } : below;
      }
      const [above, ...others] = proven?.declarations ?? [];
      if (proven === undefined || above === undefined || others.length > 0 || !ts.isClassDeclaration(above)) return UNPROVEN;
      file = proven.file;
      cls = above;
    }
  }

  /**
   * A call bound to an abstract member, or to a member only a type outside the repository holds, runs a declaration of
   * the classes below its class: `unproven` with those as its candidates, read from a hierarchy every heritage of which
   * is proven, and without candidates otherwise.
   */
  async function implementationsBelow(file: string, cls: ts.ClassDeclaration, member: string): Promise<ReceiverMethod> {
    const read = await (hierarchy ??= hierarchyOf());
    if (read === undefined) return UNPROVEN;
    const candidates: MethodPlace[] = [];
    const visited = new Set<string>();
    const pending = [...(read.below.get(keyOf(file, cls)) ?? [])];
    while (pending.length > 0) {
      const next = pending.pop()!;
      if (visited.has(next.key)) continue;
      visited.add(next.key);
      if (!ts.isClassLike(next.node)) continue;
      const declared = declaredMember(next.node, member);
      if (declared === "open") return UNPROVEN;
      if (declared !== undefined && !declared.abstract) candidates.push({ file: next.file, start: declared.start, nameLine: declared.nameLine });
      pending.push(...(read.below.get(next.key) ?? []));
    }
    return { kind: "unproven", candidates: candidates.sort((a, b) => compareText(a.file, b.file) || a.start - b.start) };
  }

  /** Every class-like of the snapshot that writes a heritage clause, with what each entry names; none when one entry is not proven. */
  async function hierarchyOf(): Promise<Hierarchy | undefined> {
    const heritageOf = heritage();
    const supertypes = new Map<string, HeritageProof[]>();
    const below = new Map<string, Below[]>();
    for (const file of heritageFiles()) {
      const tree = treeOf(file);
      if (tree === undefined) return undefined;
      const typed: (ts.ClassLikeDeclaration | ts.InterfaceDeclaration)[] = [];
      const visit = (node: ts.Node): void => {
        if ((ts.isClassLike(node) || ts.isInterfaceDeclaration(node)) && node.heritageClauses !== undefined) typed.push(node);
        node.forEachChild(visit);
      };
      visit(tree);
      for (const declaration of typed) {
        const proofs: HeritageProof[] = [];
        for (const clause of declaration.heritageClauses!) {
          for (const type of clause.types) {
            const proven = await heritageOf(file, type.expression);
            if (proven === undefined) return undefined;
            proofs.push(proven);
            if (clause.token === ts.SyntaxKind.ExtendsKeyword && typeof proven !== "string") for (const above of proven.declarations) below.set(keyOf(proven.file, above), [...(below.get(keyOf(proven.file, above)) ?? []), { key: keyOf(file, declaration), file, node: declaration }]);
          }
        }
        supertypes.set(keyOf(file, declaration), proofs);
      }
    }
    return { supertypes, below };
  }

  async function outsideAt(site: ImplementingSite): Promise<OutsideSupertypes> {
    const tree = treeOf(site.file);
    const owners = tree === undefined ? [] : membersAt(tree, site);
    const [member, ...others] = owners;
    if (member === undefined || others.length > 0) return UNKNOWN_SUPERTYPES;
    if (isStatic(member.declaration)) return { kind: "types", types: [], static: true };
    const read = await (hierarchy ??= hierarchyOf());
    if (read === undefined) return UNKNOWN_SUPERTYPES;
    const types = new Set<string>();
    const typesAbove = (key: string, seen: Set<string>): void => {
      if (seen.has(key)) return;
      seen.add(key);
      for (const proven of read.supertypes.get(key) ?? []) {
        if (typeof proven === "string") types.add(proven);
        else for (const above of proven!.declarations) typesAbove(keyOf(proven!.file, above), seen);
      }
    };
    const visited = new Set<string>();
    const pending: string[] = [keyOf(site.file, member.owner)];
    while (pending.length > 0) {
      const next = pending.pop()!;
      if (visited.has(next)) continue;
      visited.add(next);
      typesAbove(next, new Set());
      pending.push(...(read.below.get(next) ?? []).map(({ key }) => key));
    }
    return { kind: "types", types: [...types].sort() };
  }

  return {
    async receiverMethods(sites, signal) {
      const results: ReceiverMethod[] = [];
      const heritageOf = heritage();
      for (const site of sites) results.push(signal?.aborted ? UNKNOWN : await methodAt(site, heritageOf));
      return results;
    },
    async outsideSupertypes(sites, signal) {
      const results: OutsideSupertypes[] = [];
      for (const site of sites) results.push(signal?.aborted ? UNKNOWN_SUPERTYPES : await outsideAt(site));
      return results;
    },
  };
}

/** The proven supertypes of every class-like that writes a heritage clause, and the class-likes each declaration is extended by, by `keyOf`. */
interface Hierarchy {
  supertypes: ReadonlyMap<string, readonly HeritageProof[]>;
  below: ReadonlyMap<string, readonly Below[]>;
}

/** A class-like that extends a declaration, by its key, its file and its node. */
interface Below {
  key: string;
  file: string;
  node: ts.ClassLikeDeclaration | ts.InterfaceDeclaration;
}

/** A declaration by its file and offset, the same in every tree parsed from the file's text. */
function keyOf(file: string, node: ts.Node): string {
  return `${file}#${node.pos}`;
}

/** The access `this.member` or `super.member` a call is made through, when `node` is its keyword or its name. */
function accessOf(node: ts.Node, member: string): (ts.PropertyAccessExpression & { expression: ts.Expression }) | undefined {
  const access = node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword ? node.parent : ts.isIdentifier(node) || ts.isPrivateIdentifier(node) ? node.parent : undefined;
  if (access === undefined || !ts.isPropertyAccessExpression(access) || access.name.text !== member) return undefined;
  if (access.expression.kind !== ts.SyntaxKind.ThisKeyword && access.expression.kind !== ts.SyntaxKind.SuperKeyword) return undefined;
  return ts.isCallExpression(access.parent) && access.parent.expression === access ? access : undefined;
}

/** The class declaration whose instance `this` or `super` denotes at `keyword`; none in a decorator or a computed member name. */
function instanceClassOf(keyword: ts.Node): ts.ClassDeclaration | undefined {
  const owner = thisClass(keyword);
  if (owner === undefined || !ts.isClassDeclaration(owner)) return undefined;
  for (let at = keyword.parent; at !== owner; at = at.parent) if (ts.isDecorator(at) || ts.isComputedPropertyName(at) || ts.isHeritageClause(at)) return undefined;
  return owner;
}

/** The instance-side declarations of `member` a class writes, by their lines; `open` where an index signature or a computed name may declare it. */
function declaredMember(cls: ts.ClassLikeDeclaration, member: string): { start: number; nameLine: number; abstract: boolean } | "open" | undefined {
  const source = cls.getSourceFile();
  const found: ts.NamedDeclaration[] = [];
  let open = false;
  for (const declaration of cls.members) {
    if (isStatic(declaration)) continue;
    if (ts.isIndexSignatureDeclaration(declaration)) open = true;
    else if (ts.isConstructorDeclaration(declaration)) found.push(...declaration.parameters.filter((parameter) => ts.isParameterPropertyDeclaration(parameter, declaration) && ts.isIdentifier(parameter.name) && parameter.name.text === member));
    else if (ts.isMethodDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration)) {
      const name = ts.isPrivateIdentifier(declaration.name) ? declaration.name.text : propertyNameText(declaration.name);
      if (name === undefined) open = true;
      else if (name === member) found.push(declaration);
    }
  }
  if (found.length === 0) return open ? "open" : undefined;
  const kinds = new Set(found.map((declaration) => (ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration) ? "accessor" : declaration.kind)));
  if (kinds.size > 1) return "open";
  return { start: lineOf(source, found[0]!), nameLine: lineOf(source, found.at(-1)!.name!), abstract: found.every((declaration) => hasModifier(declaration, ts.SyntaxKind.AbstractKeyword)) };
}

/** Whether the scope of a class declares an interface or a namespace of its name, which may add members to it. */
function mergesOwnName(cls: ts.ClassDeclaration): boolean {
  const name = cls.name?.text;
  const scope = cls.parent;
  if (name === undefined) return true;
  const statements = ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isBlock(scope) ? scope.statements : [];
  return statements.some((statement) => (ts.isInterfaceDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement.name.text === name);
}

/** The class declaration members named as the site names whose first token is on the site's line, with their class. */
function membersAt(source: ts.SourceFile, site: ImplementingSite): { owner: ts.ClassDeclaration; declaration: ts.Node }[] {
  const found: { owner: ts.ClassDeclaration; declaration: ts.Node }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) {
      for (const member of node.members) {
        const name = member.name === undefined ? undefined : ts.isPrivateIdentifier(member.name) ? member.name.text : propertyNameText(member.name);
        if (name === site.name && lineOf(source, member) === site.start) found.push({ owner: node, declaration: member });
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return found;
}
