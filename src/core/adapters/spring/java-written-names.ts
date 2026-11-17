import { questions, type NamingKind } from "./java-declaration-questions.ts";
import { namingsOf } from "./java-declaration-index.ts";
import { bodyOf, declaredType } from "./java-declarations.ts";
import type { JavaFile, JavaProject } from "./java-symbols.ts";

/** The files of a project, each with a type, whose declarations write a name in the way `kind` says (RFC-0039 P6). */
export type FilesWriting = (kind: NamingKind, name: string) => readonly JavaFile[];

const ofProjects = new WeakMap<JavaProject, FilesWriting>();

/** What the files of a project write, read from its own declarations with the helpers that build the index entries. */
export function projectWrites(project: JavaProject): FilesWriting {
  let known = ofProjects.get(project);
  if (known === undefined) {
    const files = [...new Set(project.types.map((type) => type.file))];
    const byPath = new Map(files.map((file) => [file.path, file]));
    let named: ReturnType<typeof namingsOf> | undefined;
    known = (kind, name) => {
      named ??= namingsOf(
        files.map((file) => {
          const types = project.typesOf(file);
          return { path: file.path, types: types.map(declaredType), body: bodyOf(file, types) };
        }),
      );
      return [...(named[kind].get(name) ?? [])].flatMap((path) => byPath.get(path) ?? []);
    };
    ofProjects.set(project, known);
  }
  return known;
}

/** What the files of a project write, answered by the declaration index; each question is asked through `ask`, and each file answered is handed out by the project. */
export function indexWrites(project: JavaProject, ask: (question: string) => string, fileAt: (path: string) => JavaFile | undefined): FilesWriting {
  return (kind, name) =>
    (JSON.parse(ask(questions.naming(kind, name))) as string[]).flatMap((path) => {
      const file = fileAt(path);
      return file !== undefined && project.typesOf(file).length > 0 ? [file] : [];
    });
}
