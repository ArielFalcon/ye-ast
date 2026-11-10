/**
 * Where a read's JDK table comes from (ADR-0044 decision 10): a host path the user names, whose archive must match the
 * pinned digest, or none, which leaves every obligation that needs the table unsettled.
 */
export type JdkSignatureSource = { kind: "host"; path: string } | { kind: "none" };
