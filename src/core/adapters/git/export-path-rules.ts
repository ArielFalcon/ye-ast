const WINDOWS_FORBIDDEN_CHARACTER = /[<>:"|?*\\\u0000-\u001f]/;
const TRAILING_DOT_OR_SPACE = /[. ]$/;
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;
const GIT_DIRECTORY_ALIASES = new Set([".git", "git~1"]);

/**
 * True when every part of the path means the same thing on every host: no part is empty, `.` or `..`, holds a
 * character Windows forbids (the backslash included), ends in a dot or a space, is a Windows device name, or reads as
 * the `.git` directory under NTFS or HFS+ rules. The export holds the same files on every host.
 */
export function isConfinedPath(path: string): boolean {
  return path.split("/").every(isPortablePart);
}

function isPortablePart(part: string): boolean {
  if (part === "" || part === "." || part === "..") return false;
  if (WINDOWS_FORBIDDEN_CHARACTER.test(part) || TRAILING_DOT_OR_SPACE.test(part) || WINDOWS_DEVICE_NAME.test(part)) return false;
  return !GIT_DIRECTORY_ALIASES.has(part.replace(HFS_IGNORABLE, "").toLowerCase());
}

interface Claim {
  spelling: string;
  kind: "file" | "directory";
}

export type PathClaims = Map<string, Claim>;

/**
 * Claims the path and each of its directories under a key folded for case and Unicode normalization, as a
 * case-insensitive or normalizing file system would see them. A key held by another spelling or kind collides.
 */
export function claimPath(claimed: PathClaims, path: string): boolean {
  const parts = path.split("/");
  const claims = parts.map((_, index): [string, Claim] => {
    const spelling = parts.slice(0, index + 1).join("/");
    return [spelling.normalize("NFC").toLowerCase(), { spelling, kind: index === parts.length - 1 ? "file" : "directory" }];
  });
  const collides = claims.some(([key, claim]) => {
    const prior = claimed.get(key);
    return prior !== undefined && (claim.kind === "file" || prior.kind === "file" || prior.spelling !== claim.spelling);
  });
  if (!collides) for (const [key, claim] of claims) claimed.set(key, claim);
  return !collides;
}
