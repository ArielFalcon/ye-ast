/** A source as a key names it: what a listing read gives (`SourceFile`), seen structurally so the domain names no port. */
interface Named {
  path: string;
  content: string;
  blob?: string;
}

/**
 * What names a source's content in a key: its path and the blob id its listing gave, or its path and content when no
 * listing named it. Equal blob ids mean equal content, and the two forms never compare equal (ADR-0126).
 */
export function sourceIdentity({ path, content, blob }: Named): { path: string; blob: string } | { path: string; content: string } {
  return blob === undefined ? { path, content } : { path, blob };
}

/** `sourceIdentity` as one string, for a key that is a string. */
export function sourceKey(source: Named): string {
  return source.blob === undefined ? JSON.stringify(["content", source.path, source.content]) : JSON.stringify(["blob", source.path, source.blob]);
}
