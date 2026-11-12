import ts from "typescript";
import { angularBuildContext, recordOf, supportedBuild } from "./angular-build-context.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";

/** The build-time constants the `define` option of an Angular workspace's build targets states, by the sources they reach. */
export interface BuildDefines {
  /** The string a source's ambient constant is replaced with; undefined when no define states one string for every configuration. */
  valueOf(path: string, name: string): string | undefined;
}

/**
 * Reads the `define` of each project's `build` target (application builders only). A source belongs to the projects
 * whose root is the deepest one above it. Nothing is evaluated: only a define that is one string literal counts.
 */
export function buildDefines(files: readonly SourceFile[]): BuildDefines {
  const scopes = angularBuildContext(files)?.scopes ?? [];
  return {
    valueOf(path, name) {
      const reaching = scopes.filter(({ directory }) => directory === "" || path.startsWith(`${directory}/`));
      const depth = Math.max(-1, ...reaching.map(({ directory }) => directory.length));
      const values = reaching.filter(({ directory }) => directory.length === depth).map(({ target }) => supportedBuild(target) ? valueIn(target!, name) : undefined);
      const [first] = values;
      return first !== undefined && values.every((value) => value === first) ? first : undefined;
    },
  };
}

/** The one string every configuration of the target (the default build included) gives a name; a configuration's own `define` replaces the options' one. */
function valueIn(target: Record<string, unknown>, name: string): string | undefined {
  const defined = (define: unknown) => recordOf(define)?.[name];
  const inherited = defined(recordOf(target["options"])?.["define"]);
  const states = [inherited, ...Object.values(recordOf(target["configurations"]) ?? {}).map((configuration) => {
    const own = recordOf(configuration)?.["define"];
    return own === undefined ? inherited : defined(own);
  })];
  const literals = states.map(stringLiteral);
  const [first] = literals;
  return first !== undefined && literals.every((literal) => literal === first) ? first : undefined;
}

function stringLiteral(expression: unknown): string | undefined {
  if (typeof expression !== "string") return undefined;
  const parsed = ts.createSourceFile("define.ts", `(${expression})`, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const [statement] = parsed.statements;
  if (parsed.statements.length !== 1 || statement === undefined || !ts.isExpressionStatement(statement) || !ts.isParenthesizedExpression(statement.expression)) return undefined;
  const inner = statement.expression.expression;
  return ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) ? inner.text : undefined;
}
