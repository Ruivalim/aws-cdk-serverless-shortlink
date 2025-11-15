import { randomBytes } from 'node:crypto';

/**
 * Base62. No `-` or `_`, so a code can sit in a path segment, a hostname sub-
 * domain, or a query string without escaping.
 */
export const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Seven characters is 62^7, about 3.5 trillion codes. At a billion links the
 * chance of any given new code colliding is roughly 1 in 3500, and the write
 * is guarded by a conditional put, so a collision costs one retry and never a
 * corrupted link.
 */
export const CODE_LENGTH = 7;

/**
 * Generates a random short code.
 *
 * Uses rejection sampling rather than a plain `byte % 62`. Because 256 is not a
 * multiple of 62, a bare modulo makes the first four alphabet characters
 * slightly more likely than the rest. The bias is small, but it is trivial to
 * avoid and the reasoning is not obvious to a later reader.
 */
export function generateCode(length: number = CODE_LENGTH): string {
  // 62 * 4 = 248. Bytes at or above 248 would wrap unevenly, so they are
  // discarded and redrawn.
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  const chars: string[] = [];

  while (chars.length < length) {
    for (const byte of randomBytes(length - chars.length + 8)) {
      if (byte < limit) {
        chars.push(ALPHABET.charAt(byte % ALPHABET.length));
        if (chars.length === length) {
          break;
        }
      }
    }
  }

  return chars.join('');
}

/** Whether a string could be a code this service generated. */
export function isPlausibleCode(value: string): boolean {
  if (value.length !== CODE_LENGTH) {
    return false;
  }
  for (const char of value) {
    if (!ALPHABET.includes(char)) {
      return false;
    }
  }
  return true;
}
