import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { handler } from '../../src/handlers/redirect';
import { getCodeEvent, jsonBodyOf } from '../helpers/events';

const ddbMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);

const TABLE = 'shortlink-links-test';
const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/111111111111/shortlink-clicks-test';
const CODE = 'aB3xY9z';

function epochIn(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

function linkItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pk: `LINK#${CODE}`,
    sk: 'META',
    gsi2pk: 'URL#hash',
    url: 'https://example.com/destination',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: epochIn(3600),
    ...overrides,
  };
}

beforeEach(() => {
  ddbMock.reset();
  sqsMock.reset();
  process.env.TABLE_NAME = TABLE;
  process.env.CLICK_QUEUE_URL = QUEUE_URL;
  ddbMock.on(GetCommand).resolves({ Item: linkItem() });
  sqsMock.on(SendMessageCommand).resolves({ MessageId: 'message-id' });
});

afterAll(() => {
  delete process.env.TABLE_NAME;
  delete process.env.CLICK_QUEUE_URL;
});

describe('redirect handler', () => {
  test('returns 301 with the destination in the Location header', async () => {
    const response = await handler(getCodeEvent(CODE));

    expect(response.statusCode).toBe(301);
    expect(response.headers?.location).toBe('https://example.com/destination');
  });

  test('rejects a malformed code without reading DynamoDB', async () => {
    // Every request that cannot possibly match a real code must not cost a
    // read, or a scanner walking /abc, /abcd, ... is a free bill.
    const response = await handler(getCodeEvent('../../etc'));

    expect(response.statusCode).toBe(404);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  test('returns 404 for a code that does not exist', async () => {
    ddbMock.on(GetCommand).resolves({});

    const response = await handler(getCodeEvent(CODE));

    expect(response.statusCode).toBe(404);
    expect(jsonBodyOf(response)).toMatchObject({ error: 'not_found' });
    expect(sqsMock.calls()).toHaveLength(0);
  });

  test('returns 410 for an expired link', async () => {
    // 410 rather than 404: the link existed, and a client can tell that apart
    // from a typo.
    ddbMock.on(GetCommand).resolves({ Item: linkItem({ expiresAt: epochIn(-60) }) });

    const response = await handler(getCodeEvent(CODE));

    expect(response.statusCode).toBe(410);
    expect(jsonBodyOf(response)).toMatchObject({ error: 'link_expired' });
    expect(sqsMock.calls()).toHaveLength(0);
  });

  test('publishes a click event with the request metadata', async () => {
    await handler(
      getCodeEvent(CODE, { 'user-agent': 'Mozilla/5.0', referer: 'https://news.example' }),
    );

    const sends = sqsMock.commandCalls(SendMessageCommand);
    expect(sends).toHaveLength(1);

    expect(sends[0].args[0].input.QueueUrl).toBe(QUEUE_URL);

    const click = JSON.parse(String(sends[0].args[0].input.MessageBody)) as Record<string, unknown>;

    expect(click).toMatchObject({
      code: CODE,
      userAgent: 'Mozilla/5.0',
      referer: 'https://news.example',
    });
    expect(Number.isNaN(Date.parse(String(click.clickedAt)))).toBe(false);
  });

  test('serves the redirect even when the click cannot be enqueued', async () => {
    // Analytics is not allowed to be the reason a user cannot reach their
    // destination. If this test starts failing, that decision was reversed by
    // accident.
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    sqsMock.on(SendMessageCommand).rejects(new Error('SQS is throttling'));

    const response = await handler(getCodeEvent(CODE));

    expect(response.statusCode).toBe(301);
    expect(response.headers?.location).toBe('https://example.com/destination');
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  test('treats a missing expiresAt as not expired', async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { pk: `LINK#${CODE}`, sk: 'META', url: 'https://example.com/x' } });

    const response = await handler(getCodeEvent(CODE));

    expect(response.statusCode).toBe(301);
  });
});
