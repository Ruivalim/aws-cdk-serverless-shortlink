import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { handler } from '../../src/handlers/create-link';
import { jsonBodyOf, postLinksEvent } from '../helpers/events';

const ddbMock = mockClient(DynamoDBDocumentClient);

const TABLE = 'shortlink-links-test';

function epochIn(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

function collision(): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({ message: 'exists', $metadata: {} });
}

beforeEach(() => {
  ddbMock.reset();
  process.env.TABLE_NAME = TABLE;
  // Default: no existing link, insert succeeds.
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(PutCommand).resolves({});
});

afterAll(() => {
  delete process.env.TABLE_NAME;
});

describe('create-link handler', () => {
  test('returns 400 for a body that is not JSON', async () => {
    const response = await handler(postLinksEvent('{ not json'));

    expect(response.statusCode).toBe(400);
    expect(jsonBodyOf(response)).toMatchObject({ error: 'invalid_json' });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  test('returns 400 for an invalid URL and does not touch DynamoDB', async () => {
    const response = await handler(postLinksEvent({ url: 'javascript:alert(1)' }));

    expect(response.statusCode).toBe(400);
    expect(jsonBodyOf(response)).toMatchObject({ error: 'invalid_request' });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  test('creates a link and returns 201', async () => {
    const response = await handler(postLinksEvent({ url: 'https://example.com/page' }));

    expect(response.statusCode).toBe(201);

    const body = jsonBodyOf(response);

    expect(body.url).toBe('https://example.com/page');
    expect(String(body.code)).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(body.shortUrl).toBe(
      `https://abc123.execute-api.us-east-1.amazonaws.com/${String(body.code)}`,
    );
    expect(body.expiresAt).toBeGreaterThan(epochIn(29 * 86_400));
  });

  test('stores the link with the keys the table indexes expect', async () => {
    await handler(postLinksEvent({ url: 'https://example.com/page' }));

    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);

    const item = puts[0].args[0].input.Item;

    expect(item).toMatchObject({ sk: 'META', clicks: 0, url: 'https://example.com/page' });
    // The partition key is what makes the code resolvable, and gsi2pk is what
    // makes the next request for the same URL idempotent.
    expect(String(item?.pk)).toMatch(/^LINK#[0-9A-Za-z]{7}$/);
    expect(String(item?.gsi2pk)).toMatch(/^URL#[0-9a-f]{64}$/);
    expect(puts[0].args[0].input.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  test('returns 200 and the existing code when the same URL is submitted twice', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          pk: 'LINK#existing',
          sk: 'META',
          gsi2pk: 'URL#whatever',
          url: 'https://example.com/page',
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: epochIn(86_400),
        },
      ],
    });

    const response = await handler(postLinksEvent({ url: 'https://example.com/page' }));

    expect(response.statusCode).toBe(200);
    expect(jsonBodyOf(response)).toMatchObject({ code: 'existing' });
    // Idempotent: no second write.
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test('ignores an expired existing link and creates a fresh one', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          pk: 'LINK#expired',
          sk: 'META',
          gsi2pk: 'URL#whatever',
          url: 'https://example.com/page',
          createdAt: '2020-01-01T00:00:00.000Z',
          expiresAt: epochIn(-3600),
        },
      ],
    });

    const response = await handler(postLinksEvent({ url: 'https://example.com/page' }));

    expect(response.statusCode).toBe(201);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });

  test('retries with a new code when the insert hits a collision', async () => {
    ddbMock.on(PutCommand).rejectsOnce(collision()).resolves({});

    const response = await handler(postLinksEvent({ url: 'https://example.com/page' }));

    expect(response.statusCode).toBe(201);
    // Two attempts, two different codes.
    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(2);
    expect(puts[0].args[0].input.Item?.pk).not.toBe(puts[1].args[0].input.Item?.pk);
  });

  test('returns 503 after exhausting code attempts', async () => {
    ddbMock.on(PutCommand).rejects(collision());

    const response = await handler(postLinksEvent({ url: 'https://example.com/page' }));

    expect(response.statusCode).toBe(503);
    expect(jsonBodyOf(response)).toMatchObject({ error: 'code_unavailable' });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(3);
  });

  test('propagates a DynamoDB failure that is not a collision', async () => {
    ddbMock.on(PutCommand).rejects(new Error('throughput exceeded'));

    await expect(handler(postLinksEvent({ url: 'https://example.com/page' }))).rejects.toThrow(
      'throughput exceeded',
    );
  });

  test('falls back to a path-only short URL when the host is unknown', async () => {
    const event = postLinksEvent({ url: 'https://example.com/page' });

    const response = await handler({
      ...event,
      requestContext: { ...event.requestContext, domainName: '' },
    });

    expect(response.statusCode).toBe(201);
    expect(String(jsonBodyOf(response).shortUrl)).toMatch(/^\/[0-9A-Za-z]{7}$/);
  });
});
