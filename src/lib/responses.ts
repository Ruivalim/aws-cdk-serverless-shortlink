import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

/**
 * Response builders for the HTTP API payload v2 shape.
 *
 * Centralized so every handler returns the same content type and error body,
 * and so a change to the error format is one edit rather than six.
 */

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/** A JSON response. */
export function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  };
}

/**
 * An error response with a stable shape: `{ error, message }`.
 *
 * `error` is the machine-readable part; `message` is for a human. Clients
 * should branch on `error`, never on `message`.
 */
export function problem(
  statusCode: number,
  error: string,
  message: string,
): APIGatewayProxyStructuredResultV2 {
  return json(statusCode, { error, message });
}

/**
 * A redirect to the long URL.
 *
 * 301 by default: the mapping from code to URL never changes, so a browser (or
 * any intermediate cache) may hold on to it. That is also why the click event
 * is emitted by the handler rather than counted by the edge: a cached redirect
 * never reaches the function, and the count is best-effort by design.
 */
export function redirect(
  location: string,
  statusCode: 301 | 302 = 301,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { location },
  };
}
