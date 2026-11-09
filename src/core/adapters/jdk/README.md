# JDK archives

`jdk-archive.adapter.ts` reads a JDK's `lib/ct.sym` as data: the central directory on open, one member inflated on demand
with `node:zlib`. A `jmods` file is not a plain ZIP (it starts with a `JM` header), so the reader refuses it. It is confined to the host path the caller names (ADR-0044
decision 10, resolved question 10), and no dependency is added for it.

## Pin and digest

- **Nothing is redistributed.** ye-ast ships no JDK-derived bytes (resolved question 9): the only JDK an answer may use
  is a host JDK the user names with `--jdk`, accepted only at the pinned archive's digest.
- **The digest is the SHA-256 of the archive's bytes**, hex, over the whole file, comment included.
- The concrete JDK distribution and version, and the digest recorded for them, are fixed in V1b.1c's commit (decision
  10's "Precondition of V1b"). The adapter states no version: the pin is data, and a JDK of another digest generates
  nothing.
- **Reproduce a digest:** `shasum -a 256 <java-home>/lib/ct.sym`.

## What the reader refuses

`names` lists the central directory and inflates nothing; `entry` returns the bytes of one member. An archive that
cannot be trusted as a whole never answers a partial listing:

- a path that is absent, a link, not a regular file, or unreadable reads nothing (`names` is empty, every `entry` is
  `unreadable`, and `digest` is empty so it matches no pin);
- a truncated or corrupt archive, an end record that disagrees with the directory, or a deflated member whose local record
  or inflated size contradicts the directory answers `unreadable`, never `absent`. A stored member's size is not checked
  against its bytes yet (see Open items);
- a ZIP64 archive is unsupported: the reader follows no ZIP64 record and refuses the sentinels;
- a member is read only when its compression method is stored (`0`) or deflate (`8`);
- an entry name is listed and read only when it is relative, inside the archive, and free of `..` segments, a leading
  separator or a drive prefix.

Every length is bounded by the file's own size: the reader never allocates from a header alone, and a deflated member
is bounded by its compressed size (deflate expands at most about 1032:1). That bound is defensive: a valid deflate stream
expands at most about 1026:1, so the cut is reached only by a malformed stream.

## Open items

- A stored member (`0`) whose directory size disagrees with its bytes is returned truncated, not `unreadable`. Checking it
  needs the member's end, and a data descriptor (flag bit 3, which `ct.sym` sets on every member) leaves the local sizes
  zero. Deciding that rule is a design choice, not made here.
