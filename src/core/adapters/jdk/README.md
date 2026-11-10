# JDK signatures

Generate with `node --import tsx scripts/jdk-signatures.ts --jdk <home> --out <table> [--digest <sha256>]`.
Nothing is redistributed; generated tables are not committed.

The pin is Java SE 23.0.1, release 23. Only java.* modules and release sets containing N are selected.
Directory entries and .jmod archives are excluded. Every selected declaration must decode.

Accepted whole ct.sym SHA-256 digests:

- Oracle JDK 23.0.1+11-39 (10744455 bytes): e47b50ac58efc23859ade811e266307a3fc9d9b9b65fff01b830b0e9d8aae263
- OpenJDK 23.0.1+11-39 (10157226 bytes): 4a8cfcd91fd9156268e350f8473168927c4ccca21fd5c87285153f4934f0e1c6

Both contain identical release-23 java.* content: 4848 entries, zero undefined decodes, content hash d55db8f757663be8.
Accepting both widens the generating host, never the asserted table. Other digests produce no output.
Release directory names are sets (A=10 through N=23), including shared directories such as LMN.
Canonical JSON sorts object keys and members, preserves parameter order, and contains no timestamps.
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

## The host JDK (`--jdk`)

- `init` and `mcp` accept `--jdk <path>` once: the JDK home the user names (`lib/ct.sym` is read from it). The path is
  resolved against the working directory and printed into the MCP registration that `init` prints.
- `jdkSignaturesOf` (`jdk-signature-source.ts`) generates the table in memory, once per process and path. A path that is
  unreadable, an archive whose digest is not one of the two pinned digests, or a pinned archive that does not decode
  yields no table (`undefined`): every obligation that needs the table stays unsettled. Nothing is written to disk.
- No query reads the table yet; the flag only carries the path until the unit that consumes it lands.

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

## The class-file decoder

`class-file.ts` decodes one member of that archive: a class file, or the `.sig` of `ct.sym`, which is a class file
without method bodies. `readClassFile(bytes)` answers the declaration ADR-0044 decision 10 holds, or `undefined`.

### What is read

| Part | Read |
|---|---|
| constant pool | every entry is skipped by the size its tag states (a `Long`/`Double` takes two slots); only `Utf8` and `Class` are kept |
| class flags | `ACC_ANNOTATION`, `ACC_ENUM`, `ACC_INTERFACE`, `ACC_ABSTRACT` |
| class attribute | `Signature` (type parameters and generic supertypes), `Record` (the kind) |
| supertypes | `super_class` and `interfaces`, or the `Signature`'s version of them; an interface's `java.lang.Object` superclass is no superinterface and is left out |
| methods | public and protected only; `ACC_BRIDGE` and `ACC_SYNTHETIC` are left out; each keeps `ACC_STATIC`, `ACC_ABSTRACT` and `ACC_VARARGS` |
| method attribute | `Signature` (type parameters, parameter and return types); without it the descriptor's types |
| other attributes | skipped by their stated length, as JVMS 4.7 requires |

A type is rendered in Java source form with fully qualified names and the signature's type variables kept:
`java.util.List<T>`, `int`, `java.lang.String[]`, `? extends java.lang.Number`. A binary name keeps its source form, so
`java/util/Map$Entry` is `java.util.Map.Entry`; a constructor keeps the class file's name, `<init>`; a varargs parameter
keeps its array form and states it again through `varargs`. A member's signature is used only while every type variable
it names is declared by the class or by the member; a signature that names an undeclared variable (an inner class's
artifact) is dropped and the descriptor's erased types are stated instead.

### What makes the whole declaration `undefined`

Never a partial declaration: the file is `undefined` when

- it is not a class file (its magic is not `0xCAFEBABE`);
- it is truncated or a stated length reaches past its end;
- it carries a constant pool tag this reader does not know;
- it is a module (`ACC_MODULE`) or a synthetic (`ACC_SYNTHETIC`) class, which state no declaration of their own;
- a `Signature` attribute does not parse, or names a type variable the class signature does not declare;
- a generic class signature states a different number of supertypes than the class file's own fields;
- `ACC_VARARGS` is set on a method whose last parameter is not an array.

No network, no dependency: the decoder reads the bytes it is handed.
