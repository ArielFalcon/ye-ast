export interface EntryStatus {
  symbolicLink: boolean;
  uid: number;
  mode: number;
}

/**
 * Why an entry is no private place of the account `ownerUid`, or `null` when it is: not a symbolic link, owned by that
 * account, and closed to the group and to everyone else.
 */
export function privateToOwner({ symbolicLink, uid, mode }: EntryStatus, ownerUid: number): string | null {
  if (symbolicLink) return "is a symbolic link";
  if (uid !== ownerUid) return "belongs to another account";
  return (mode & 0o077) === 0 ? null : "is open to other accounts";
}
