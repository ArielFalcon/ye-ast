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
}

export type RootOrigin = Finding<ImportOrigin> & { bare?: true };

/** Reads the import bindings of one snapshot; composition supplies it, so no use case imports a parser. */
export type ImportOriginsReader = (sources: readonly SourceFile[]) => ImportOrigins;
