import ts from "typescript";

interface Candidate {
  declaration: ts.VariableDeclaration;
  block: ts.Block;
  boundary: ts.Node;
  valid: boolean;
  writes: Set<ts.Expression>;
}

const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** A unique local binding, a fresh null-prototype object and an exhaustive write-only use census. */
export function privateRecordWriteTargets(source: ts.SourceFile, declarations: ReadonlyMap<string, number>): ReadonlySet<ts.Expression> {
  const candidates = new Map<string, Candidate>();
  const collect = (node: ts.Node, boundary?: ts.Node): void => {
    const scope = ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isModuleDeclaration(node) ? node : boundary;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && declarations.get(node.name.text) === 1
      && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0
      && ts.isVariableStatement(node.parent.parent) && ts.isBlock(node.parent.parent.parent)
      && scope !== undefined && ts.isFunctionLike(scope) && nullPrototypeLiteral(node.initializer)) {
      candidates.set(node.name.text, { declaration: node, block: node.parent.parent.parent, boundary: scope, valid: true, writes: new Set() });
    }
    node.forEachChild((child) => collect(child, scope));
  };
  collect(source);
  if (candidates.size === 0) return new Set();

  const census = (node: ts.Node, boundary?: ts.Node): void => {
    const scope = ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isModuleDeclaration(node) ? node : boundary;
    if (ts.isIdentifier(node)) {
      const candidate = candidates.get(node.text);
      if (candidate !== undefined && node !== candidate.declaration.name && isBindingUse(node)) {
        const access = node.parent;
        const property = ts.isPropertyAccessExpression(access) && !ts.isPropertyAccessChain(access) && access.expression === node ? access.name.text
          : ts.isElementAccessExpression(access) && !ts.isElementAccessChain(access) && access.expression === node && access.argumentExpression !== undefined
            && (ts.isStringLiteral(access.argumentExpression) || ts.isNumericLiteral(access.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(access.argumentExpression)) ? access.argumentExpression.text : undefined;
        const parent = access.parent;
        const write = (ts.isBinaryExpression(parent) && parent.left === access && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
          || (ts.isDeleteExpression(parent) && parent.expression === access);
        if (scope !== candidate.boundary || node.getStart(source) < candidate.declaration.end
          || node.pos < candidate.block.pos || node.end > candidate.block.end || property === undefined
          || PROTOTYPE_KEYS.has(property) || !write) candidate.valid = false;
        else candidate.writes.add(access as ts.Expression);
      }
    }
    node.forEachChild((child) => census(child, scope));
  };
  census(source);
  return new Set([...candidates.values()].filter((candidate) => candidate.valid).flatMap((candidate) => [...candidate.writes]));
}

function nullPrototypeLiteral(expression: ts.Expression | undefined): boolean {
  if (expression === undefined || !ts.isObjectLiteralExpression(expression) || expression.properties.length !== 1) return false;
  const property = expression.properties[0]!;
  return ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    && property.name.text === "__proto__" && property.initializer.kind === ts.SyntaxKind.NullKeyword;
}

function isBindingUse(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  return !("name" in parent && parent.name === node && !ts.isShorthandPropertyAssignment(parent));
}
