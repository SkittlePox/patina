/** FNV-1a (32-bit) over UTF-16 code units, as an unsigned integer. */
export function hashLineInt(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Line fingerprint as stored in marks: FNV-1a (32-bit) rendered base36. */
export function hashLine(text: string): string {
  return hashLineInt(text).toString(36);
}

const NONE = '\u0001';

/** Fingerprint of a line's surroundings (the line above and below). Used only to disambiguate re-anchoring. */
export function contextHash(prev: string | undefined, next: string | undefined): string {
  return hashLine((prev ?? NONE) + '\u0000' + (next ?? NONE));
}
