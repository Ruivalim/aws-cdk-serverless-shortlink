/**
 * Parsing and validation of the `POST /links` request body.
 *
 * Separated from the handler so the rules can be tested directly, without
 * standing up a Lambda invocation for every edge case.
 */

/** Longest long URL accepted. DynamoDB caps an item at 400 KB; this is a UX limit. */
export const MAX_URL_LENGTH = 2048;

/** Default lifetime of a link, in days. */
export const DEFAULT_TTL_DAYS = 30;

/** Upper bound on `ttlDays`, so a link cannot be created effectively forever. */
export const MAX_TTL_DAYS = 3650;

export type ValidationResult =
  | { readonly ok: true; readonly url: string; readonly ttlDays: number }
  | { readonly ok: false; readonly message: string };

/**
 * Validates a parsed request body.
 *
 * Only `http:` and `https:` are accepted. Anything else (`javascript:`,
 * `data:`, `file:`) would turn the redirect endpoint into an open redirector
 * for a scheme the browser may act on, which is a real vulnerability rather
 * than a validation nicety.
 */
export function validateCreateLink(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, message: 'Request body must be a JSON object.' };
  }

  const { url, ttlDays } = body as { url?: unknown; ttlDays?: unknown };

  if (typeof url !== 'string' || url.length === 0) {
    return { ok: false, message: 'Field "url" is required and must be a string.' };
  }

  if (url.length > MAX_URL_LENGTH) {
    return { ok: false, message: `Field "url" must be at most ${MAX_URL_LENGTH} characters.` };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: 'Field "url" must be an absolute URL.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: 'Field "url" must use the http or https scheme.' };
  }

  const resolvedTtl = ttlDays ?? DEFAULT_TTL_DAYS;

  if (typeof resolvedTtl !== 'number' || !Number.isInteger(resolvedTtl)) {
    return { ok: false, message: 'Field "ttlDays" must be an integer.' };
  }

  if (resolvedTtl < 1 || resolvedTtl > MAX_TTL_DAYS) {
    return {
      ok: false,
      message: `Field "ttlDays" must be between 1 and ${MAX_TTL_DAYS}.`,
    };
  }

  return { ok: true, url: parsed.toString(), ttlDays: resolvedTtl };
}
