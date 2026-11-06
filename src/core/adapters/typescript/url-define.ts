import ts from "typescript";
import { posix } from "node:path";
import { isAngularWorkspace } from "../../domain/languages/typescript.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";

const DEFINE_BUILDERS = [":application", ":browser-esbuild"];
const BUILD_TARGET = "build";

interface Target {
  options?: { define?: Record<string, unknown> };
  builder?: unknown;
  configurations?: Record<string, { define?: Record<string, unknown> } | undefined>;
}

/** The build-time constants the `define` option of an Angular workspace's build targets states, by the sources they reach. */
export interface BuildDefines {
  /** The string a source's ambient constant is replaced with; undefined when no define states one string for every configuration. */
  valueOf(path: string, name: string): string | undefined;
}

interface Scope {
  directory: string;
  target: Target;
}

/**
 * Reads the `define` of each project's `build` target (application builders only). A source belongs to the projects
 * whose root is the deepest one above it. Nothing is evaluated: only a define that is one string literal counts.
 */
export function buildDefines(files: readonly SourceFile[]): BuildDefines {
  const scopes = files.filter(({ path }) => isAngularWorkspace(path)).flatMap(scopesOf);
  return {
    valueOf(path, name) {
      const reaching = scopes.filter(({ directory }) => directory === "" || path.startsWith(`${directory}/`));
      const depth = Math.max(-1, ...reaching.map(({ directory }) => directory.length));
      const values = reaching.filter(({ directory }) => directory.length === depth).map(({ target }) => valueIn(target, name));
      const [first] = values;
      return first !== undefined && values.every((value) => value === first) ? first : undefined;
    },
  };
}

function scopesOf(file: SourceFile): Scope[] {
  let workspace: unknown;
  try {
    workspace = JSON.parse(file.content);
  } catch {
    return [];
  }
  const projects = recordOf(recordOf(workspace)?.["projects"]);
  if (projects === undefined) return [];
  return Object.values(projects).flatMap((project) => {
    const declared = recordOf(project);
    const root = typeof declared?.["root"] === "string" ? declared["root"] : "";
    const target = recordOf(recordOf(declared?.["architect"] ?? declared?.["targets"])?.[BUILD_TARGET]) as Target | undefined;
    const builder = target?.builder;
    const defines = typeof builder === "string" && DEFINE_BUILDERS.some((suffix) => builder.endsWith(suffix));
    return [{ directory: posix.join(posix.dirname(file.path), root).replace(/^\.$/, ""), target: defines && target !== undefined ? target : {} }];
  });
}

/** The one string every configuration of the target (the default build included) gives a name; a configuration's own `define` replaces the options' one. */
function valueIn(target: Target, name: string): string | undefined {
  const defined = (define: unknown) => recordOf(define)?.[name];
  const inherited = defined(recordOf(target.options)?.["define"]);
  const states = [inherited, ...Object.values(recordOf(target.configurations) ?? {}).map((configuration) => {
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

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
