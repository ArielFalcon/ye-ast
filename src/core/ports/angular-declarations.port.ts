import type { SourceFile } from "./entrypoint-extractor.port.ts";

export type AngularDecorator = "Component" | "Directive" | "Pipe" | "Injectable" | "NgModule";

/** A class an Angular decorator marks, read from the decorator metadata alone. */
export interface AngularDeclaration {
  file: string;
  name: string;
  /** The line of the class name. */
  line: number;
  decorator: AngularDecorator;
  /** The repository paths the decorator names in `templateUrl`, `styleUrl` and `styleUrls` as string literals. */
  resources: readonly string[];
}

export interface AngularDeclarationReader {
  /**
   * The declarations of the TypeScript sources of a repository whose root `package.json` names `@angular/core`, by file
   * and line; none for any other repository. Nothing is built or run.
   */
  read(files: readonly SourceFile[]): Promise<readonly AngularDeclaration[]>;
}
