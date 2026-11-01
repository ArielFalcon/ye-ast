/** A declaration of the code graph as the facts see it: where it is and what it is called. */
export interface CodeNode {
  file: string;
  name: string;
  startLine: number;
  endLine: number;
}

/** A place a fact names: a file and a line, and the declaration's name, qualified or not, when the fact gives one. */
export interface FactLocation {
  path: string;
  line: number;
  symbol?: string;
}

/**
 * The one join between a graph node and a fact: same file, the fact's line inside the node's span, and the same simple
 * name (what follows the last dot) when the fact has a symbol. The graph's qualified names and overloads never decide it.
 */
export function joinsFact(node: CodeNode, location: FactLocation): boolean {
  return (
    node.file === location.path &&
    node.startLine <= location.line &&
    location.line <= node.endLine &&
    (location.symbol === undefined || node.name === location.symbol.slice(location.symbol.lastIndexOf(".") + 1))
  );
}

/** Position order, the order every list of nodes keeps: file, start line, name, then the handle that tells equal positions apart. */
export function comparePosition(a: CodeNode & { id: string }, b: CodeNode & { id: string }): number {
  return compareText(a.file, b.file) || a.startLine - b.startLine || compareText(a.name, b.name) || compareText(a.id, b.id);
}

/** Code unit order, the order every list of paths and names keeps. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
