import { createHash } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ddb, requireEnv } from '../lib/clients';
import { generateCode } from '../lib/codes';
import { linkKey, urlIndexKey } from '../lib/keys';
import { codeFromKey, expirationEpoch, isExpired, shortUrlFor, type LinkItem } from '../lib/links';
import { json, problem } from '../lib/responses';
import { validateCreateLink } from '../lib/validation';

/**
 * How many times to redraw a code before giving up. Collisions are already
 * vanishingly unlikely (62^7 keyspace); three attempts exists so that a
 * pathological run of collisions is a 503 the client can retry rather than an
 * infinite loop pinning the invocation.
 */
const MAX_CODE_ATTEMPTS = 3;

/** Reads the table name lazily so importing this module needs no environment. */
function tableName(): string {
  return requireEnv('TABLE_NAME');
}

/**
 * `POST /links`
 *
 * Creates a short link, or returns the existing one for the same long URL.
 * Idempotent by design: the same input twice produces the same code, which
 * makes a retried request (a browser refresh, a flaky network) harmless.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  let body: unknown;
  try {
    body = event.body ? JSON.parse(event.body) : undefined;
  } catch {
    return problem(400, 'invalid_json', 'Request body must be valid JSON.');
  }

  const validation = validateCreateLink(body);
  if (!validation.ok) {
    return problem(400, 'invalid_request', validation.message);
  }

  const { url, ttlDays } = validation;
  const table = tableName();
  const urlHash = createHash('sha256').update(url).digest('hex');

  const existing = await findExistingLink(table, urlHash);
  if (existing) {
    return json(200, {
      code: codeFromKey(existing.pk),
      url: existing.url,
      shortUrl: shortUrlFor(event, codeFromKey(existing.pk)),
      expiresAt: existing.expiresAt,
    });
  }

  const createdAt = new Date();
  const expiresAt = expirationEpoch(ttlDays, createdAt);

  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = generateCode();

    try {
      await ddb.send(
        new PutCommand({
          TableName: table,
          Item: {
            ...linkKey(code),
            ...urlIndexKey(urlHash),
            url,
            createdAt: createdAt.toISOString(),
            expiresAt,
            clicks: 0,
          },
          // The whole reason a collision is safe: the write fails instead of
          // overwriting an existing link.
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );

      return json(201, {
        code,
        url,
        shortUrl: shortUrlFor(event, code),
        expiresAt,
      });
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        continue;
      }
      throw error;
    }
  }

  return problem(503, 'code_unavailable', 'Could not allocate a unique code. Try again.');
}

/**
 * Looks up a live link by its URL hash through `gsi2`.
 *
 * An expired match is treated as absent: the URL is free to be shortened
 * again, and the stale item ages out with the TTL.
 */
async function findExistingLink(table: string, urlHash: string): Promise<LinkItem | undefined> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: table,
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :pk',
      ExpressionAttributeValues: { ':pk': urlIndexKey(urlHash).gsi2pk },
      Limit: 1,
    }),
  );

  const item = result.Items?.[0] as LinkItem | undefined;
  if (!item || isExpired(item)) {
    return undefined;
  }
  return item;
}
