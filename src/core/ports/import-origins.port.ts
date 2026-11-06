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
   * it with no default, rest or destructuring, never declared again, is `local-parameter`.
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
}

/** A place a declaration uses a name, where the index places the use: repository-relative and 1-based. */
export interface UseSite {
  file: string;
  line: number;
  /** 1-based UTF-16 column. */
  column: number;
  /** The identifier, `this` or `super` the index's spelling of the use starts with, written at the site. */
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
  | { kind: "this"; member?: string }
  | { kind: "unknown" };

/** Reads the import bindings of one snapshot; composition supplies it, so no use case imports a parser. */
export type ImportOriginsReader = (sources: readonly SourceFile[]) => ImportOrigins;
