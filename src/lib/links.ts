import type { APIGatewayProxyEventV2 } from 'aws-lambda';

/**
 * Link and click shapes, plus the predicate both handlers and the consumer need
 * to agree on. Splitting this out keeps the definition of "expired" in one
 * place: a redirect and a click consumer disagreeing about expiry is the kind
 * of bug that only shows up in production.
 */

/** A link's metadata item as stored in DynamoDB. */
export interface LinkItem {
  readonly pk: string;
  readonly sk: string;
  readonly gsi2pk: string;
  readonly url: string;
  readonly createdAt: string;
  /** Unix epoch seconds. DynamoDB TTL deletes the item after this. */
  readonly expiresAt: number;
  /** Denormalized counter, incremented by the click consumer. */
  clicks?: number;
}

/** The message the redirect handler puts on the queue for each click. */
export interface ClickEvent {
  readonly code: string;
  readonly clickedAt: string;
  readonly userAgent?: string;
  readonly referer?: string;
}

const SECONDS_PER_DAY = 86_400;

/** Unix epoch seconds at which a link created now should expire. */
export function expirationEpoch(ttlDays: number, now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000) + ttlDays * SECONDS_PER_DAY;
}

/**
 * Whether a link is past its expiry.
 *
 * The item may still exist after `expiresAt`: DynamoDB TTL deletes lazily, up
 * to 48 hours late. Treating the timestamp as authoritative means a link stops
 * working on time, whether or not the TTL sweep has caught up.
 */
export function isExpired(item: { expiresAt?: unknown }, now: Date = new Date()): boolean {
  const expiresAt = item.expiresAt;
  if (typeof expiresAt !== 'number') {
    return false;
  }
  return expiresAt <= Math.floor(now.getTime() / 1000);
}

/** Extracts the short code from a link's partition key. */
export function codeFromKey(pk: string): string {
  return pk.replace(/^LINK#/, '');
}

/**
 * Absolute URL of a short link, derived from the request rather than a
 * configured base URL.
 *
 * Passing the API's endpoint into the function as environment would create a
 * dependency cycle: the function needs the API's URL, and the API needs the
 * function to exist as an integration. Reading the host off the request has
 * neither problem, and produces the right answer on any stage.
 */
export function shortUrlFor(event: APIGatewayProxyEventV2, code: string): string {
  const domain = event.requestContext?.domainName;
  return domain ? `https://${domain}/${code}` : `/${code}`;
}
