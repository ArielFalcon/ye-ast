import type { Frozen } from "../migration.testing.ts";

/**
 * The identities, sizes and the reply bytes of the legacy `renderImporters` text of each fixture of
 * `importers.fixtures.testing.ts`, frozen while the legacy renderer still existed (RFC-0041 U6). Its paths and lines were
 * printed as `"path": categories at 12, 30` under a target file, a form the token extractor reads as no identity.
 */
export const IMPORTERS_LEGACY: Readonly<Record<string, Frozen>> = {
 "memberships across every category": {
  "summary": [],
  "details": [],
  "bytes": {
   "summary": 778,
   "details": 778
  }
 },
 "two targets sharing thirty related files without recorded lines": {
  "summary": [],
  "details": [],
  "bytes": {
   "summary": 536,
   "details": 4113
  }
 },
 "partial with cuts": {
  "summary": [
   "anchor src/C.java::C.save"
  ],
  "details": [
   "anchor src/B.java::B.save",
   "anchor src/C.java::C.save"
  ],
  "bytes": {
   "summary": 600,
   "details": 550
  }
 },
 "unknown fact": {
  "summary": [
   "entry unknown (unresolved)",
   "place src/gone.ts:1"
  ],
  "details": [
   "entry unknown (unresolved)",
   "place src/gone.ts:1"
  ],
  "bytes": {
   "summary": 112,
   "details": 112
  }
 },
 "a file without related files": {
  "summary": [],
  "details": [],
  "bytes": {
   "summary": 120,
   "details": 120
  }
 }
};
