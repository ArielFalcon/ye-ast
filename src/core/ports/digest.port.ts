export interface Digest {
  /** Lowercase hex SHA-256 of the UTF-8 bytes of `text`. */
  of(text: string): string;
}
