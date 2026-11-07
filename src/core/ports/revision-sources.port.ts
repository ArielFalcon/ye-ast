import type { Cut } from "../domain/shared/fact.ts";
import type { Result } from "../domain/shared/result.ts";
import type { SourceFile } from "./entrypoint-extractor.port.ts";
import type { WorkspaceRequest } from "./workspace-queries.port.ts";
import type { WorkspaceFault } from "./workspace-repos.port.ts";

/** The sources one commit of a repository holds that a reader of contracts needs, and what the read left out. */
export interface RevisionFiles {
  files: readonly SourceFile[];
  /** The listed paths the read could not take (a budget that stopped the export, a path or submodule left out). */
  cuts: readonly Cut[];
}

/** The commits of the repository a request is bound to, read from git and never from its working tree. */
export interface RevisionSources {
  /** The commit a revision names; the request's other repositories are not consulted. */
  resolve(request: WorkspaceRequest, revision: string): Promise<Result<string, WorkspaceFault>>;
  filesAt(request: WorkspaceRequest, sha: string): Promise<Result<RevisionFiles, WorkspaceFault>>;
}
