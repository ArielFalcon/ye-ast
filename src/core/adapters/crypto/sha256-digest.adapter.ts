import { createHash } from "node:crypto";
import type { Digest } from "../../ports/digest.port.ts";

export function createSha256Digest(): Digest {
  return { of: (text) => createHash("sha256").update(text, "utf8").digest("hex") };
}
