import type { RootOrigin } from "../domain/impact/edge-policy.ts";
import type { ImportOrigin } from "../domain/relations/resolved-reference.ts";
import type { Finding } from "../domain/shared/fact.ts";
import type { SourceFile } from "./entrypoint-extractor.port.ts";

/** One place a file uses a name, as the index reports it: repository-relative and 1-based. */
export interface ImportOriginSite {
  file: string;
  line: number;
  /** 1-based UTF-16 column, normalized from the graph. */
  column?: number;
  /** Full graph spelling and kind, for validating the exact occurrence. */
  fullName?: string;
  kind?: string;
  /** The identifier the name is rooted at: `a.b()` is rooted at `a`, and `this.svc.get` at `this`. */
  name: string;
}

/** A place the index resolved a name to a declaration, where it writes the edge: repository-relative and 1-based. */
export interface ResolvedNameSite {
  file: string;
  line: number;
  /** 1-based UTF-16 column: the callee's start for a call, the `new` keyword for an instantiation, the name otherwise. */
  column: number;
  kind: string;
  /** The name of the declaration the edge reaches. */
  name: string;
}

/**
 * Where the names a file uses come from, read from the file's own imports. Declared by its consumer,
 * `core/application/impact`: a reference whose rooted name is imported from outside the repository cannot name the
 * declaration a cut attributes to it, so the cut is false and stops being emitted (`RFC-0016` gap A).
 *
 * It is a different proof from type resolution and needs no type root: it reads the specifiers the file already writes
 * and the module configuration the snapshot already carries.
 */
export interface ImportOrigins {
  /**
   * One entry per site, in the order received. `unknown` when the file declares the name itself, when the specifier
   * resolves nowhere, or when nothing binds it and no library declares it: an import or a repository global a local
   * declaration may shadow proves nothing, and a hidden dependence is worse than a false cut.
   *
   * `ambient` is the second proof of an external target (`RFC-0016` S10): nothing binds the name here, the language's own
   * libraries declare it, and the snapshot declares no global of that name. `this-member` is a bare call written on
   * `this` inside a class member, which names that class's member.
   */
  origins(sites: readonly ImportOriginSite[], signal?: AbortSignal): Promise<readonly (Finding<ImportOrigin> & { occurrence?: true })[]>;
  /**
   * One entry per site, in the order received: where the name the syntax spells at the site is rooted, as `origins`
   * answers for that root. Complete only when the site holds a chain of plain names (`a`, `a.b.c`) that ends
   * in the site's `name`; a computed chain (`f().b`, `this.b`, `a[b]`), another name or a file that does not parse is
   * `unknown`. `bare` marks a site that spells its root alone (`a`), so a binding of the root is the binding of the name;
   * such a root in a value position that, by the file's own scoping (ADR-0029), binds a parameter of a function around
   * it with no default, rest or destructuring, never declared again, is `local-parameter`. `pastRoot` marks a call that
   * reads past its root (`readsPastRoot`: `a.b.c()`), whose root proves where the chain starts and not what the call runs.
   */
  rootOrigins(sites: readonly ResolvedNameSite[], signal?: AbortSignal): Promise<readonly RootOrigin[]>;
  /**
   * One entry per site, in the order received: what binds, at the site's own place, the name the expression written
   * there is rooted at (`ts` for `ts.Expression` placed at either name, `f` for `f(x).g`, `Set` for `new Set(a).add(k)`).
   * A value name is bound by the file's own scoping (ADR-0029); a type name by the type scopes around it, then the file's
   * imports and top-level declarations; `super` by the root of its class's `extends` expression. `unknown` when the place
   * spells another name, the name is dynamic, or nothing proves a binding.
   */
  rootBindings(sites: readonly UseSite[], signal?: AbortSignal): Promise<readonly RootBinding[]>;
  /**
   * One entry per site, in the order received: the library or package type the annotation written at the site states,
   * its first name spelled as `spelled` (a primitive keyword, `Array` for an array type, or a type name). A keyword is
   * its library type (`string` is `String`); a name the type scopes and the file leave unbound is a global of the
   * language's libraries, and an import of a package the repository depends on is that package's export by its exported
   * name. `unknown` when the repository declares the type (save a `nominal` class, below), the name binds nothing (generated code), the package is one
   * the repository declares itself, or an in-scope repository type extends or implements the same type, so a value of
   * it may run repository code; every site is `unknown` when some heritage reaches no repository class, interface or type
   * literal and no library or package type (ADR-0029 decision 9). A repository class is `nominal` only under that same
   * heritage proof, when its one declaration itself declares a `private`, `protected` or `#` instance member; one it
   * inherits proves nothing, since siblings below the declaring class fit too (ADR-0029 decision 11).
   */
  declaredTypes(sites: readonly UseSite[], signal?: AbortSignal): Promise<readonly DeclaredType[]>;
  /**
   * One entry per site, in the order received: every method body a call to the body-less method declared at the site
   * runs, read from the sources' declared hierarchy (RFC-0013 R7). `unknown` when a value the sources do not place may
   * run another body: the language types structurally (TypeScript), a supertype or a class chain the strict reading
   * does not settle, an anonymous or local class, a lambda where the owner is functional, a generator or a proxy that may
   * implement the owner, or a class that inherits the method from outside the repository.
   */
  dispatchTargets(sites: readonly DispatchSite[], signal?: AbortSignal): Promise<readonly DispatchTargets[]>;
  /**
   * One entry per site, in the order received: the method a member call names by the type the sources declare its
   * receiver to hold (RFC-0013 R3, R5), the declaration a call on a value of that type is resolved to at compile time,
   * below which dispatch decides the body. The type is a repository type stated by the receiver's parameter, local or
   * private field, or the declared return type of the repository method a receiver call names in the same way (`f().m()`).
   * `unknown` when the language types structurally (TypeScript), when nothing states the type, when it is a type variable,
   * when the type's hierarchy reaches a type outside the repository, when its members of the name are not one signature of
   * the call's arity (an overload, a varargs, a private or an `Object` method), or when the declared hierarchy does not
   * prove the bodies a value of the type may run for it (`dispatchTargets`).
   */
  receiverMethods(sites: readonly ReceiverCallSite[], signal?: AbortSignal): Promise<readonly ReceiverMethod[]>;
  /**
   * Where the repository may run its own code where a library's is expected: the path of every global the snapshot
   * declares, every member path a source writes from a global (`Math.max = f`, `Array.prototype[k] = f`,
   * `globalThis.fetch = f`, `Object.assign(process.env, vars)`), and every package a source writes through an import of
   * (`_.map = f`). An external call at or below one of them proves nothing.
   */
  replacedRoots(signal?: AbortSignal): Promise<ReplacedRoots>;
}

export interface ReplacedRoots {
  /**
   * Member paths from the global they start at (`["Array", "prototype", "push"]`), sorted. A `*` segment is a name no
   * write states and stands for every name in its place, so `["process", "env", "*"]` covers `process.env.HOME` and not
   * `process.cwd`; a path that starts at `*` starts at a global no name states (`*.prototype.push` for
   * `value.__proto__.push = f`).
   */
  paths: readonly (readonly string[])[];
  /** Names that hold the global object itself: a call's path through one starts at the global after it. */
  globalObjects: ReadonlySet<string>;
  /** Package names, as an import specifier's first one or two segments name them (`lodash`, `@angular/core`). */
  packages: ReadonlySet<string>;
}

/**
 * A type from outside the repository: a global of the language's libraries, or a package's export. `nominal`: a
 * repository class that itself declares a `private`, `protected` or `#` instance member, so only an instance of it or of
 * a subclass fits the annotation (an `any` or a cast aside), at the line of its name.
 */
export type DeclaredType = { kind: "global"; name: string } | { kind: "package"; module: string; name: string } | { kind: "nominal"; file: string; name: string; line: number } | { kind: "unknown" };

/** A body-less method by its file, a 1-based line from its declaration's first token to its name, and its name. */
export interface DispatchSite {
  file: string;
  line: number;
  name: string;
}

/** The method bodies a call to a body-less method may run, each by its file and the 1-based lines from its first token to its name, sorted. */
export type DispatchTargets = { kind: "bodies"; bodies: readonly { file: string; start: number; nameLine: number }[] } | { kind: "unknown" };

/** A member call by the place it starts, repository-relative and 1-based with a UTF-16 column, and the member it calls. */
export interface ReceiverCallSite {
  file: string;
  line: number;
  column: number;
  member: string;
}

/**
 * The method declaration a call names, by its file and the 1-based lines from its first token to its name; `unproven`
 * when the call's receiver is a value it reads (a parameter, a local, a field, a member of another value or what another
 * call returns) and the sources may make a value of any declared type run code they do not show, so no index edge from
 * the call proves what it runs either.
 */
export type ReceiverMethod = { kind: "method"; file: string; start: number; nameLine: number } | { kind: "unproven" } | { kind: "unknown" };

/** A place a declaration uses a name, where the index places the use: repository-relative and 1-based. */
export interface UseSite {
  file: string;
  line: number;
  /** 1-based UTF-16 column. */
  column: number;
  /**
   * A name of the chain the site begins: the identifier, `this` or `super` the index's spelling of an unresolved use
   * starts with, written at the site, or the name a resolved use reaches, written anywhere along the chain.
   */
  spelled: string;
  /** The declaration whose body writes the use, as the index places it: its name and the 1-based lines it spans. */
  owner: { name: string; line: number; endLine: number };
}

/**
 * What binds a use's root, the first name of the chain written at the site: an import (with the name after the root, for
 * a namespace), a declaration of the file outside the owner's syntax (by the 1-based lines its names are written on),
 * a declaration the owner's own syntax holds (`local`), a declaration of a repository file by its dotted containment
 * path, the language, or `this` (with the member after it).
 */
export type RootBinding =
  | { kind: "import"; root: string; member?: string; origin: Extract<ImportOrigin, { kind: "repository" | "external" }> }
  /** `captured`: every declaration is a value (a parameter, a variable or a catch binding) of a function around the use. */
  | { kind: "declared"; root: string; lines: readonly number[]; captured: boolean }
  | { kind: "local"; root: string }
  | { kind: "located"; root: string; file: string; path: string }
  | { kind: "ambient"; root: string }
  /** The sources name more than one declaration the root could be, or only a wildcard import could supply it. */
  | { kind: "ambiguous"; root: string }
  | { kind: "this"; member?: string }
  | { kind: "unknown" };

/**
 * Reads the import bindings of one snapshot; composition supplies it, so no use case imports a parser. `paths` is every path
 * of the snapshot's scope, files no reader parses included; the sources' own paths when not given.
 */
export type ImportOriginsReader = (sources: readonly SourceFile[], paths?: readonly string[]) => ImportOrigins;
