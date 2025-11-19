import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ddb, requireEnv, sqs } from '../lib/clients';
import { isPlausibleCode } from '../lib/codes';
import { linkKey } from '../lib/keys';
import { isExpired, type ClickEvent, type LinkItem } from '../lib/links';
import { problem, redirect } from '../lib/responses';

/** Reads config lazily so importing this module needs no environment. */
function tableName(): string {
  return requireEnv('TABLE_NAME');
}

function queueUrl(): string {
  return requireEnv('CLICK_QUEUE_URL');
}

/**
 * `GET /{code}`
 *
 * Resolves a short code and redirects. The click event is published to SQS as
 * a side effect.
 *
 * The publish is best-effort on purpose. Analytics must never be the reason a
 * user cannot reach their destination: if SQS is throttling or the queue is
 * unreachable, the redirect still happens and the failure is logged. The cost
 * of that choice is a click that goes uncounted, which is the right trade.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const code = event.pathParameters?.code;

  // Reject anything that could not be one of our codes before spending a
  // DynamoDB read on it. Also keeps traversal-looking input out of the logs.
  if (!code || !isPlausibleCode(code)) {
    return problem(404, 'not_found', 'No link matches that code.');
  }

  const result = await ddb.send(
    new GetCommand({
      TableName: tableName(),
      Key: linkKey(code),
    }),
  );

  const item = result.Item as LinkItem | undefined;

  if (!item) {
    return problem(404, 'not_found', 'No link matches that code.');
  }

  if (isExpired(item)) {
    // 410 rather than 404: the link existed and is gone. Clients can tell a
    // typo apart from an expired link.
    return problem(410, 'link_expired', 'That link has expired.');
  }

  await publishClick(code, event).catch((error: unknown) => {
    console.error('Failed to publish click event; redirect served anyway', {
      code,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return redirect(item.url);
}

/** Publishes one click event. Errors propagate to the caller's catch. */
async function publishClick(code: string, event: APIGatewayProxyEventV2): Promise<void> {
  const click: ClickEvent = {
    code,
    clickedAt: new Date().toISOString(),
    userAgent: event.headers?.['user-agent'],
    referer: event.headers?.['referer'],
  };

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl(),
      MessageBody: JSON.stringify(click),
    }),
  );
}
