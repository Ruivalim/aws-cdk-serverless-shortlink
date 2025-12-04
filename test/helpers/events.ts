import type { APIGatewayProxyEventV2, SQSEvent, SQSRecord } from 'aws-lambda';

/**
 * Event builders for handler tests.
 *
 * Written out by hand rather than pulled from a fixtures package so the shape
 * is visible and the tests depend on nothing beyond `@types/aws-lambda`.
 */

type RequestContext = APIGatewayProxyEventV2['requestContext'];

const DEFAULT_DOMAIN = 'abc123.execute-api.us-east-1.amazonaws.com';

function requestContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    accountId: '111111111111',
    apiId: 'api-id',
    domainName: DEFAULT_DOMAIN,
    domainPrefix: 'abc123',
    http: {
      method: 'GET',
      path: '/',
      protocol: 'HTTP/1.1',
      sourceIp: '127.0.0.1',
      userAgent: 'jest',
    },
    requestId: 'request-id',
    routeKey: '$default',
    stage: '$default',
    time: '01/Jan/2026:00:00:00 +0000',
    timeEpoch: 1767225600000,
    ...overrides,
  };
}

/** An HTTP API payload v2 event. */
export function httpEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/',
    rawQueryString: '',
    headers: {},
    requestContext: requestContext(),
    isBase64Encoded: false,
    ...overrides,
  };
}

/** An HTTP API event for `POST /links` with a JSON body. */
export function postLinksEvent(
  body: unknown,
  headers: Record<string, string> = {},
): APIGatewayProxyEventV2 {
  return httpEvent({
    routeKey: 'POST /links',
    rawPath: '/links',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    requestContext: requestContext({
      routeKey: 'POST /links',
      http: {
        method: 'POST',
        path: '/links',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'jest',
      },
    }),
  });
}

/** An HTTP API event for `GET /{code}`. */
export function getCodeEvent(
  code: string,
  headers: Record<string, string> = {},
): APIGatewayProxyEventV2 {
  return httpEvent({
    routeKey: 'GET /{code}',
    rawPath: `/${code}`,
    pathParameters: { code },
    headers,
    requestContext: requestContext({
      routeKey: 'GET /{code}',
      http: {
        method: 'GET',
        path: `/${code}`,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'jest',
      },
    }),
  });
}

function sqsRecord(body: string, messageId: string): SQSRecord {
  return {
    messageId,
    receiptHandle: 'receipt-handle',
    body,
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: '1767225600000',
      SenderId: 'sender',
      ApproximateFirstReceiveTimestamp: '1767225600000',
    },
    messageAttributes: {},
    md5OfBody: 'md5',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:111111111111:shortlink-clicks-dev',
    awsRegion: 'us-east-1',
  };
}

/** An SQS event carrying the given message bodies, one record each. */
export function sqsEvent(bodies: string[]): SQSEvent {
  return {
    Records: bodies.map((body, index) => sqsRecord(body, `message-${index}`)),
  };
}

/**
 * Parses a handler response body.
 *
 * `JSON.parse` returns `any`, which would let unsafe access spread through
 * every assertion. Narrowing it here keeps the tests typed.
 */
export function jsonBodyOf(response: { body?: string }): Record<string, unknown> {
  return JSON.parse(response.body ?? '{}') as Record<string, unknown>;
}
