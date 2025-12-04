import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { handler } from '../../src/handlers/click-consumer';
import { sqsEvent } from '../helpers/events';

const ddbMock = mockClient(DynamoDBDocumentClient);

const TABLE = 'shortlink-links-test';

function clickBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    code: 'aB3xY9z',
    clickedAt: '2026-01-01T00:00:00.000Z',
    userAgent: 'Mozilla/5.0',
    referer: 'https://news.example',
    ...overrides,
  });
}

beforeEach(() => {
  ddbMock.reset();
  process.env.TABLE_NAME = TABLE;
  ddbMock.on(UpdateCommand).resolves({});
});

afterAll(() => {
  delete process.env.TABLE_NAME;
});

describe('click-consumer handler', () => {
  test('records a click and reports no failures', async () => {
    const result = await handler(sqsEvent([clickBody()]));

    expect(result.batchItemFailures).toEqual([]);

    const updates = ddbMock.commandCalls(UpdateCommand);
    expect(updates).toHaveLength(1);

    const input = updates[0].args[0].input;

    expect(String(input.Key?.pk)).toBe('LINK#aB3xY9z');
    expect(String(input.Key?.sk)).toMatch(/^CLICK#2026-01-01T00:00:00\.000Z#/);
    expect(input.UpdateExpression).toContain('ADD clicks :one');
  });

  test('sets a TTL on the click record', async () => {
    // A click row is telemetry. Without an expiry it outlives every link it
    // describes, in the table nobody is looking at.
    await handler(sqsEvent([clickBody()]));

    const values = ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues;

    expect(typeof values?.[':ttl']).toBe('number');
    expect(values?.[':ttl']).toBeGreaterThan(Math.floor(Date.now() / 1000) + 89 * 86_400);
  });

  test('processes a whole batch', async () => {
    const result = await handler(sqsEvent([clickBody(), clickBody(), clickBody()]));

    expect(result.batchItemFailures).toEqual([]);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(3);
  });

  test('reports only the failing message id, not the batch', async () => {
    // This is the whole point of returning batchItemFailures: one bad record
    // must not send the good ones back to the queue to be counted twice.
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    ddbMock
      .on(UpdateCommand)
      .resolvesOnce({})
      .rejectsOnce(new Error('write failed'))
      .resolvesOnce({});

    const result = await handler(sqsEvent([clickBody(), clickBody(), clickBody()]));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'message-1' }]);

    consoleError.mockRestore();
  });

  test('reports a message whose body is not valid JSON', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await handler(sqsEvent(['{ not json']));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'message-0' }]);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);

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
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);

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
