import { ALPHABET, CODE_LENGTH, generateCode, isPlausibleCode } from '../../src/lib/codes';

describe('generateCode', () => {
  test('produces a code of the expected length', () => {
    expect(generateCode()).toHaveLength(CODE_LENGTH);
    expect(generateCode(4)).toHaveLength(4);
    expect(generateCode(32)).toHaveLength(32);
  });

  test('only uses characters from the alphabet', () => {
    for (let i = 0; i < 200; i++) {
      for (const char of generateCode()) {
        expect(ALPHABET).toContain(char);
      }
    }
  });

  test('never produces a character outside base62', () => {
    // The alphabet must stay URL-safe: a `-` or `_` would need escaping in a
    // path segment and change the URL depending on the client.
    expect(ALPHABET).toMatch(/^[0-9A-Za-z]+$/);
    expect(ALPHABET).toHaveLength(62);
  });

  test('produces different codes on successive calls', () => {
    const codes = new Set(Array.from({ length: 1000 }, () => generateCode()));

    // With 62^7 keys, 1000 draws colliding would mean the source is not random.
    expect(codes.size).toBe(1000);
  });

  test('draws from the whole alphabet, not just the first characters', () => {
    // Guards the rejection sampling: a plain `byte % 62` biases toward the
    // first four characters, which this distribution check would catch.
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i++) {
      for (const char of generateCode(4)) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
      }
    }

    const expected = (4000 * 4) / ALPHABET.length;

    // Every character must appear at least half of its expected share. Loose on
    // purpose: this is a smoke test for gross bias, not a statistical test.
    for (const char of ALPHABET) {
      expect(counts.get(char) ?? 0).toBeGreaterThan(expected / 2);
    }
  });

  test('zero length returns an empty string rather than hanging', () => {
    expect(generateCode(0)).toBe('');
  });
});

describe('isPlausibleCode', () => {
  test('accepts a generated code', () => {
    expect(isPlausibleCode(generateCode())).toBe(true);
  });

  test.each([
    ['too short', 'abc'],
    ['too long', 'abcdefgh'],
    ['empty', ''],
    ['path traversal', '../../etc'],
    ['invalid character', 'abc-def'],
    ['space', 'abc def'],
    ['percent encoding', 'abc%20d'],
  ])('rejects %s', (_label, value) => {
    expect(isPlausibleCode(value)).toBe(false);
  });

  test('rejects a code with a valid length but a non-base62 character', () => {
    expect(isPlausibleCode('abcdef!')).toBe(false);
  });
});
