/** Why a live query was refused or could not read the working tree. */
export interface LiveFault {
  kind: "live-requires-trusted" | "unsupported-object-format" | "live-mirror-failed";
  detail: string;
}

const LIVE_FAULTS: ReadonlySet<string> = new Set<LiveFault["kind"]>(["live-requires-trusted", "unsupported-object-format", "live-mirror-failed"]);

export function isLiveFault(fault: { kind: string }): fault is LiveFault {
  return LIVE_FAULTS.has(fault.kind);
}

/**
 * Said beside a live answer when the working tree moved after it was built (RFC-0002 rule 8): `stateId` is the state the
 * answer reflects and `changed` the paths whose stat differs from it. The state the tree is in now is not named, since
 * only hashing the changed files would tell.
 */
export interface LiveStaleNotice {
  stateId: string;
  changed: readonly string[];
}

/**
 * Asks for the working tree of a `trusted` repository instead of a revision (RFC-0010 "Live head"). Under `untrusted` the
 * query answers `live-requires-trusted` before reading anything. `onStale` is called once, after the answer is built,
 * when the tree changed since; the answer itself is unchanged.
 */
export interface LiveSelector {
  live: true;
  onStale?: (notice: LiveStaleNotice) => void;
}

/** A request of a query family at a revision: the variant without `live`. */
export type AtRevision<Request> = Extract<Request, { live?: undefined }>;
