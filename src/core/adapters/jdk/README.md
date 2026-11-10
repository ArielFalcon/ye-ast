# JDK archives

`jdk-archive.adapter.ts` reads a JDK's `lib/ct.sym` as data: the central directory on open, one member inflated on demand
with `node:zlib`. Only `ct.sym` is read: a `.jmod` carries a `JM` header before its ZIP, so it answers `unreadable` and is
never unwrapped. The reader is confined to the host path the caller names (ADR-0044 decision 10, resolved question 10),
and no dependency is added for it.

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
- a truncated or corrupt archive answers `unreadable`, never `absent`. An end record is resolved by the directory it
  states, never by being the last signature whose comment reaches the end of the file: that directory must end exactly
  where the record starts, parse record by record, and the local records and their data descriptors must tile the file
  from its first byte to that start, so a record forged inside another record's comment states no directory and is
  rejected;
- a member's local record is compared with the directory by its signature, its method and its name, and its inflated
  size must equal the directory's stated size; its two local size fields are not compared, because general-purpose bit 3
  leaves them zero in `ct.sym` while the directory always states them, and a stored member (`0`) must state one size for
  both its compressed and uncompressed form;
- a member's data is bounded by the next record's start and by the directory's start, so an over-declared size answers
  `unreadable` instead of reaching into a neighbour;
- an archive that is not single-disk, that repeats an entry name, or that encrypts an entry (general-purpose bit 0) is
  refused as a whole;
- the end record's disk-entry count is not compared with its total-entry count; both disks must state zero and the
  directory the record states is the only one read;
- a gap of even one byte between two records, or between the directory and the end record, refuses the archive; `unzip`
  refuses that padding too;
- a ZIP64 archive is unsupported: the reader follows no ZIP64 record and refuses the sentinels;
- a member is read only when its compression method is stored (`0`) or deflate (`8`);
- an entry name is listed and read only when it is relative, inside the archive, free of a NUL byte, and free of `..`
  segments, a leading separator or a drive prefix.

Every length is bounded by the file's own size, by the directory's stated sizes and by the next record's start: the
reader never allocates from a header alone. A deflated member is inflated at most to the smaller of its declared
uncompressed size and `compressedSize × 1032` (RFC 1951's 32 KiB window bounds deflate at about 1032:1), so a member
declaring a small size is never inflated past it.
