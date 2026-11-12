import ts from "typescript";
import type { FrameworkValueReading, SourceExpression } from "../../ports/framework-values.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { FileNames } from "./angular-injection.ts";
import type { ModuleResolver } from "./module-resolver.ts";

export interface ValueUnit extends FileNames { source: ts.SourceFile }
export interface LocatedValue { unit: ValueUnit; expression: ts.Expression }

/** A framework projection over the request reader's held trees; source coordinates never expose compiler nodes. */
export class RequestValueReading implements FrameworkValueReading {
  readonly language = "typescript" as const;
  private readonly expressions = new Map<string, ReadonlyMap<string, ts.Expression>>();
  constructor(readonly files: readonly SourceFile[], readonly units: ReadonlyMap<string, ValueUnit>, readonly modules: ModuleResolver, readonly constant: (unit: ValueUnit, name: string) => Promise<LocatedValue | undefined>) {}

  at(expression: ts.Expression): SourceExpression {
    const source = expression.getSourceFile();
    return { file: source.fileName, start: expression.getStart(source), end: expression.getEnd() };
  }

  expression(at: SourceExpression): ts.Expression | undefined {
    let indexed = this.expressions.get(at.file);
    const unit = this.units.get(at.file);
    if (unit === undefined) return undefined;
    if (indexed === undefined) {
      const values = new Map<string, ts.Expression>();
      const visit = (node: ts.Node): void => { if (ts.isExpression(node)) values.set(`${node.getStart(unit.source)}:${node.getEnd()}`, node); ts.forEachChild(node, visit); };
      visit(unit.source);
      indexed = values;
      this.expressions.set(at.file, indexed);
    }
    return indexed.get(`${at.start}:${at.end}`);
  }
}
