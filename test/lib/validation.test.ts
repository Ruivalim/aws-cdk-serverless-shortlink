import {
  DEFAULT_TTL_DAYS,
  MAX_TTL_DAYS,
  MAX_URL_LENGTH,
  validateCreateLink,
} from '../../src/lib/validation';

describe('validateCreateLink', () => {
  test('accepts an https URL and applies the default TTL', () => {
    const result = validateCreateLink({ url: 'https://example.com/a/b?c=d' });

    expect(result).toEqual({
      ok: true,
      url: 'https://example.com/a/b?c=d',
      ttlDays: DEFAULT_TTL_DAYS,
    });
  });

  test('accepts an http URL', () => {
    const result = validateCreateLink({ url: 'http://example.com' });

    expect(result.ok).toBe(true);
  });

  test('accepts an explicit TTL', () => {
    const result = validateCreateLink({ url: 'https://example.com', ttlDays: 7 });

    expect(result).toEqual({ ok: true, url: 'https://example.com/', ttlDays: 7 });
  });

  test.each([
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['file:', 'file:///etc/passwd'],
    ['ftp:', 'ftp://example.com/file'],
  ])('rejects the %s scheme', (_scheme, url) => {
    // A redirect endpoint that forwards any scheme is an open redirector. This
    // is the test that keeps that from regressing.
    const result = validateCreateLink({ url });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/http or https/);
  });

  test('rejects a relative URL', () => {
    const result = validateCreateLink({ url: '/relative/path' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/absolute URL/);
  });

  test('rejects a missing url field', () => {
    expect(validateCreateLink({}).ok).toBe(false);
    expect(validateCreateLink({ url: 42 }).ok).toBe(false);
    expect(validateCreateLink({ url: '' }).ok).toBe(false);
  });

  test('rejects a URL longer than the limit', () => {
    const url = `https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`;

    const result = validateCreateLink({ url });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/at most/);
  });

  test('accepts a URL exactly at the limit', () => {
    const prefix = 'https://example.com/';
    const url = prefix + 'a'.repeat(MAX_URL_LENGTH - prefix.length);

    expect(url).toHaveLength(MAX_URL_LENGTH);
    expect(validateCreateLink({ url }).ok).toBe(true);
  });

  test.each([[0], [-1], [1.5], ['7'], [MAX_TTL_DAYS + 1]])('rejects the TTL %p', (ttlDays) => {
    const result = validateCreateLink({ url: 'https://example.com', ttlDays });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/ttlDays/);
  });

  test('treats an explicit null TTL as unspecified', () => {
    // `null ?? default` is the intended reading: JSON has no way to say
    // "absent" for a key the client sent on purpose, and rejecting null would
    // be a needless incompatibility.
    const result = validateCreateLink({ url: 'https://example.com', ttlDays: null });

    expect(result).toEqual({ ok: true, url: 'https://example.com/', ttlDays: DEFAULT_TTL_DAYS });
  });

  test('accepts the boundary TTLs', () => {
    expect(validateCreateLink({ url: 'https://example.com', ttlDays: 1 }).ok).toBe(true);
    expect(validateCreateLink({ url: 'https://example.com', ttlDays: MAX_TTL_DAYS }).ok).toBe(true);
  });

  test.each([[null], ['string'], [42], [[]]])('rejects a %p body', (body) => {
    const result = validateCreateLink(body);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/JSON object/);
  });

  test('normalizes the URL before it is stored', () => {
    // Two spellings of the same URL must hash to the same value, or the
    // idempotency lookup in the handler silently stops working.
    const upper = validateCreateLink({ url: 'HTTPS://EXAMPLE.COM/path' });
    const lower = validateCreateLink({ url: 'https://example.com/path' });

    expect(upper.ok && upper.url).toBe(lower.ok && lower.url);
  });
});
