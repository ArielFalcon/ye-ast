/** Changing what any key means changes this version, and with it every id. */
export const COMPOSITION_KEY_VERSION = "mcp-composition-v1";

/** The prefix of every wire id kind. */
export const ID_PREFIXES = {
  source: "s1", read: "r1", snapshot: "v1", file: "f1", anchor: "a1", evidence: "e1",
  part: "p1", entity: "n1", relation: "l1", connection: "c1",
} as const;
export type IdKind = keyof typeof ID_PREFIXES;
export type IdOf<K extends IdKind> = `${(typeof ID_PREFIXES)[K]}:${string}`;

/** Digest identities always have a namespace; they are distinct from Git's bare SHA-1/SHA-256 object ids. */
export const DIGEST_ID = /^mcp-c1:[0-9a-f]{64}$/;
export type DigestNamespace = (typeof ID_PREFIXES)[IdKind] | "mcp-c1" | "mcp-r1";
export function namespacedDigestPattern(namespace: DigestNamespace): RegExp {
  return new RegExp(DIGEST_ID.source.replace("mcp-c1", namespace));
}

/** Whether a string is a well-formed id of that kind. */
export function isCompositionId<K extends IdKind>(kind: K, value: unknown): value is IdOf<K> {
  return typeof value === "string" && namespacedDigestPattern(ID_PREFIXES[kind]).test(value);
}
