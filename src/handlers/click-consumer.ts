import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { ddb, requireEnv } from '../lib/clients';
import { clickKey, linkKey } from '../lib/keys';
import { expirationEpoch, type ClickEvent } from '../lib/links';

/**
 * Click records expire well before the links they belong to. The link is the
 * product; the click row is telemetry, and keeping telemetry forever is how a
 * table nobody looks at becomes the biggest line on the bill.
 */
const CLICK_TTL_DAYS = 90;

function tableName(): string {
  return requireEnv('TABLE_NAME');
}

/**
 * SQS consumer that records clicks.
 *
 * Returns `batchItemFailures` rather than throwing. Throwing would return the
 * whole batch to the queue and re-deliver the clicks that already succeeded;
 * reporting only the failed message ids means one bad record costs one retry,
 * not a batch. This only takes effect if the event source mapping is created
 * with `reportBatchItemFailures: true` (see the API stack).
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];

  await Promise.all(
    event.Records.map(async (record) => {
      try {
        await recordClick(record);
      } catch (error) {
        console.error('Failed to record click; returning message to the queue', {
          messageId: record.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
        failures.push({ itemIdentifier: record.messageId });
      }
    }),
  );

  return { batchItemFailures: failures };
}

/**
 * Writes the click record and bumps the link's counter.
 *
 * Two separate writes rather than one, and that is the whole point: the click
 * record lives at `pk = LINK#<code>, sk = CLICK#<at>#<uuid>`, while the counter
 * belongs on the link's metadata item at `sk = META`. A single update against
 * the click record would increment a field on the row it just created and leave
 * the link's own counter at zero forever.
 */
async function recordClick(record: SQSRecord): Promise<void> {
  const click = parseClick(record.body);
  const table = tableName();
  const id = randomUUID();

  await Promise.all([
    ddb.send(
      new PutCommand({
        TableName: table,
        Item: clickItem(click, id),
      }),
    ),
    bumpCounter(table, click.code),
  ]);
}

/** Builds the click row. Optional fields are added only when present. */
function clickItem(click: ClickEvent, id: string): Record<string, unknown> {
  // Optional fields are omitted rather than set to undefined: the document
  // client would drop the undefined ones anyway, and building the item from
  // what actually exists is what keeps the shape honest.
  const item: Record<string, unknown> = {
    ...clickKey(click.code, click.clickedAt, id),
    clickedAt: click.clickedAt,
    expiresAt: expirationEpoch(CLICK_TTL_DAYS),
  };

  if (click.userAgent !== undefined) {
    item.userAgent = click.userAgent;
  }

  if (click.referer !== undefined) {
    item.referer = click.referer;
  }

  return item;
}

/**
 * Increments `clicks` on the link's metadata item.
 *
 * Guarded by `attribute_exists(pk)` so that a click arriving for a link the TTL
 * already deleted does not resurrect it as an item with a counter and no URL.
 * Losing the counter bump in that case is correct; the click row is still
 * written, so the event is not lost.
 */
async function bumpCounter(table: string, code: string): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: linkKey(code),
        UpdateExpression: 'ADD clicks :one',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':one': 1 },
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      console.warn('Link no longer exists; click recorded without a counter bump', { code });
      return;
    }
    throw error;
  }
}

/** Parses and checks a click message. Throws so the record is retried. */
function parseClick(body: string): ClickEvent {
  const parsed: unknown = JSON.parse(body);

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Click message is not an object');
  }

  const { code, clickedAt } = parsed as Partial<ClickEvent>;

  if (typeof code !== 'string' || code.length === 0) {
    throw new Error('Click message has no code');
  }

  if (typeof clickedAt !== 'string' || Number.isNaN(Date.parse(clickedAt))) {
    throw new Error('Click message has no valid clickedAt');
  }

  return parsed as ClickEvent;
}
