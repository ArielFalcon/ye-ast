import type { RemoteFreshness, RemoteListing } from "../domain/topology/remote-snapshot.ts";

/** A remote the workspace declares, to be refreshed into ye-ast's mirror before a cross-repository query. */
export interface RemoteRefreshRequest {
  /** The source of truth the declaration states: the only URL the refresh reads, never a query parameter. */
  url: string;
  /** The local clone of the same URL, when one exists: the first mirror is seeded from it, never fetched from. */
  seed?: string;
}

/** What the refresh answered for one remote: the listing it verified, the freshness, and where its pinned sha is read. */
export interface RefreshedRemote {
  url: string;
  /** The branches the remote's listing stated, or the last recorded one when this query did not reach the remote. */
  listing?: RemoteListing;
  /** Whether this query verified the remote; carried beside the fact, never inside it. */
  freshness: RemoteFreshness;
  /** The mirror to read the pinned revision from, present when one exists from this or an earlier query. */
  mirror?: string;
}

/**
 * Refreshes declared remotes into ye-ast's own mirrors under `trusted`, with the user's git and credentials: one listing
 * per remote, and the commits the mirror lacks. A failure is the remote's freshness, never a fault of the query. Under
 * `untrusted`, or with `--offline`, no implementation is called.
 */
export interface RemoteRefresh {
  refresh(requests: readonly RemoteRefreshRequest[], signal?: AbortSignal): Promise<readonly RefreshedRemote[]>;
}
