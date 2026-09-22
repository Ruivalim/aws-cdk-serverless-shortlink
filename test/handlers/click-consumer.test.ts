import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { handler } from '../../src/handlers/click-consumer';
import { sqsEvent } from '../helpers/events';

const ddbMock = mockClient(DynamoDBDocumentClient);

const TABLE = 'shortlink-links-test';
const CODE = 'aB3xY9z';

function clickBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    code: CODE,
    clickedAt: '2026-01-01T00:00:00.000Z',
    userAgent: 'Mozilla/5.0',
    referer: 'https://news.example',
    ...overrides,
  });
}

beforeEach(() => {
  ddbMock.reset();
  process.env.TABLE_NAME = TABLE;
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
});

afterAll(() => {
  delete process.env.TABLE_NAME;
});

describe('click-consumer handler', () => {
  test('records a click and reports no failures', async () => {
    const result = await handler(sqsEvent([clickBody()]));

    expect(result.batchItemFailures).toEqual([]);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });

  test('writes the click row under the link partition', async () => {
    await handler(sqsEvent([clickBody()]));

    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;

    expect(item?.pk).toBe(`LINK#${CODE}`);
    expect(String(item?.sk)).toMatch(/^CLICK#2026-01-01T00:00:00\.000Z#/);
    expect(item?.clickedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(item?.userAgent).toBe('Mozilla/5.0');
    expect(item?.referer).toBe('https://news.example');
  });

  test('bumps the counter on the link metadata item, not on the click row', async () => {
    // The bug this test exists for: a single update against the click row
    // increments a field on the row it just created, and the link's own
    // counter stays at zero forever.
    await handler(sqsEvent([clickBody()]));

    const updates = ddbMock.commandCalls(UpdateCommand);
    expect(updates).toHaveLength(1);

    const input = updates[0].args[0].input;

    expect(input.Key).toEqual({ pk: `LINK#${CODE}`, sk: 'META' });
    expect(input.UpdateExpression).toBe('ADD clicks :one');
    expect(input.ExpressionAttributeValues?.[':one']).toBe(1);
  });

  test('guards the counter bump so a deleted link is not resurrected', async () => {
    // Without the condition, an ADD against a missing item creates one: a
    // "link" with a counter and no URL.
    await handler(sqsEvent([clickBody()]));

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;

    expect(input.ConditionExpression).toBe('attribute_exists(pk)');
  });

  test('still succeeds when the link was already deleted', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'gone', $metadata: {} }));

    const result = await handler(sqsEvent([clickBody()]));

    // The click row was written, so the event is not lost and must not be
    // retried. Only the counter bump is skipped.
    expect(result.batchItemFailures).toEqual([]);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  test('sets a TTL on the click record', async () => {
    // A click row is telemetry. Without an expiry it outlives every link it
    // describes, in the table nobody is looking at.
    await handler(sqsEvent([clickBody()]));

    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;

    expect(typeof item?.expiresAt).toBe('number');
    expect(Number(item?.expiresAt)).toBeGreaterThan(Math.floor(Date.now() / 1000) + 89 * 86_400);
  });

  test('omits optional fields that were not sent', async () => {
    await handler(sqsEvent([clickBody({ userAgent: undefined, referer: undefined })]));

    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;

    expect(item).not.toHaveProperty('userAgent');
    expect(item).not.toHaveProperty('referer');
  });

  test('processes a whole batch', async () => {
    const result = await handler(sqsEvent([clickBody(), clickBody(), clickBody()]));

    expect(result.batchItemFailures).toEqual([]);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(3);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(3);
  });

  test('reports only the failing message id, not the batch', async () => {
    // One bad record must not send the good ones back to the queue to be
    // counted twice.
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    ddbMock.on(PutCommand).resolvesOnce({}).rejectsOnce(new Error('write failed')).resolvesOnce({});

    const result = await handler(sqsEvent([clickBody(), clickBody(), clickBody()]));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'message-1' }]);

    consoleError.mockRestore();
  });

  test('reports a message whose body is not valid JSON', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await handler(sqsEvent(['{ not json']));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'message-0' }]);
    expect(ddbMock.calls()).toHaveLength(0);

    consoleError.mockRestore();
  });

  test.each([
    ['no code', clickBody({ code: undefined })],
    ['empty code', clickBody({ code: '' })],
    ['no clickedAt', clickBody({ clickedAt: undefined })],
    ['invalid clickedAt', clickBody({ clickedAt: 'not-a-date' })],
  ])('rejects a message with %s', async (_label, body) => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await handler(sqsEvent([body]));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'message-0' }]);
    expect(ddbMock.calls()).toHaveLength(0);

    consoleError.mockRestore();
  });

  test('rejects a body that is valid JSON but not an object', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await handler(sqsEvent(['"just a string"', '42', 'null']));

    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: 'message-0' },
      { itemIdentifier: 'message-1' },
      { itemIdentifier: 'message-2' },
    ]);

    consoleError.mockRestore();
  });
});
