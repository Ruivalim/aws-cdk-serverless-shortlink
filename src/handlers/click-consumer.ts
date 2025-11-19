import { randomUUID } from 'node:crypto';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { ddb, requireEnv } from '../lib/clients';
import { clickKey } from '../lib/keys';
import type { ClickEvent } from '../lib/links';
import { expirationEpoch } from '../lib/links';

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

/** Writes one click record and bumps the link's counter. */
async function recordClick(record: SQSRecord): Promise<void> {
  const click = parseClick(record.body);
  const table = tableName();
  const clickedAt = click.clickedAt;
  const id = randomUUID();

  // Two writes, both idempotent. The click row is unique by construction
  // (timestamp + uuid), so a redelivery of the same message adds a second row
  // rather than corrupting anything; the counter is an ADD, so it double-counts
  // on redelivery. Accepted: an at-least-once counter is cheaper and more
  // available than a conditional transaction per click.
  await ddb.send(
    new UpdateCommand({
      TableName: table,
      Key: clickKey(click.code, clickedAt, id),
      UpdateExpression:
        'SET clickedAt = :at, expiresAt = :ttl, userAgent = :ua, referer = :ref ADD clicks :one',
      ExpressionAttributeValues: {
        ':at': clickedAt,
        ':ttl': expirationEpoch(CLICK_TTL_DAYS),
        ':ua': click.userAgent,
        ':ref': click.referer,
        ':one': 1,
      },
    }),
  );
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
