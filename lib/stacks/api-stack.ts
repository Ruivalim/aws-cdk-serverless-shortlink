import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import path from 'node:path';
import type { Construct } from 'constructs';
import { ClickQueue } from '../constructs/click-queue';
import { HttpApi } from '../constructs/http-api';
import { LambdaFn } from '../constructs/lambda-function';
import type { LinksTable } from '../constructs/links-table';

const HANDLERS_DIR = path.join(__dirname, '..', '..', 'src', 'handlers');

export interface ApiStackProps extends StackProps {
  /** Environment name, used for resource naming (`dev`, `prod`). */
  readonly environment: string;

  /** The links table, owned by the data stack. */
  readonly linksTable: LinksTable;
}

/**
 * The request path: HTTP API, the three functions, and the queue between them.
 *
 * This stack is the only place that wires permissions. Every grant goes
 * through a construct helper (`linksTable.grantRead`, `clickQueue.grantSend`),
 * so what each function can do is legible at the point of wiring rather than
 * buried in a policy document.
 */
export class ApiStack extends Stack {
  public readonly httpApi: HttpApi;

  public readonly clickQueue: ClickQueue;

  public readonly createLinkFn: LambdaFn;

  public readonly redirectFn: LambdaFn;

  public readonly clickConsumerFn: LambdaFn;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { environment, linksTable } = props;
    const tableName = linksTable.table.tableName;

    this.clickQueue = new ClickQueue(this, 'Clicks', {
      queueName: `shortlink-clicks-${environment}`,
      // Three times the consumer's timeout, so a slow batch never overlaps
      // with its own redelivery.
      visibilityTimeout: Duration.seconds(30),
    });

    this.httpApi = new HttpApi(this, 'Http', {
      apiName: `shortlink-${environment}`,
      throttlingRateLimit: environment === 'prod' ? 500 : 50,
      throttlingBurstLimit: environment === 'prod' ? 1000 : 100,
    });

    this.createLinkFn = new LambdaFn(this, 'CreateLink', {
      functionName: `shortlink-create-link-${environment}`,
      entry: path.join(HANDLERS_DIR, 'create-link.ts'),
      // Writes to DynamoDB and nothing else: no queue access, no table reads
      // beyond the idempotency lookup the grant allows.
      environment: { TABLE_NAME: tableName },
      timeout: Duration.seconds(5),
    });
    linksTable.grantReadWrite(this.createLinkFn.fn);

    this.redirectFn = new LambdaFn(this, 'Redirect', {
      functionName: `shortlink-redirect-${environment}`,
      entry: path.join(HANDLERS_DIR, 'redirect.ts'),
      // The hottest path in the system and the one users wait on: 256 MB is
      // enough for a single GetItem and keeps the per-invocation cost down.
      environment: {
        TABLE_NAME: tableName,
        CLICK_QUEUE_URL: this.clickQueue.queue.queueUrl,
      },
      timeout: Duration.seconds(5),
      memorySize: 256,
    });
    linksTable.grantRead(this.redirectFn.fn);
    this.clickQueue.grantSend(this.redirectFn.fn);

    this.clickConsumerFn = new LambdaFn(this, 'ClickConsumer', {
      functionName: `shortlink-click-consumer-${environment}`,
      entry: path.join(HANDLERS_DIR, 'click-consumer.ts'),
      environment: { TABLE_NAME: tableName },
      timeout: Duration.seconds(10),
      memorySize: 256,
    });
    linksTable.grantWrite(this.clickConsumerFn.fn);
    this.clickQueue.grantConsume(this.clickConsumerFn.fn);

    this.clickConsumerFn.fn.addEventSource(
      new SqsEventSource(this.clickQueue.queue, {
        batchSize: 10,
        // Without this, one malformed message would fail the whole batch and
        // the good clicks in it would be reprocessed.
        reportBatchItemFailures: true,
        maxBatchingWindow: Duration.seconds(5),
      }),
    );

    this.httpApi.api.addRoutes({
      path: '/links',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('CreateLinkIntegration', this.createLinkFn.fn),
    });

    this.httpApi.api.addRoutes({
      path: '/{code}',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('RedirectIntegration', this.redirectFn.fn),
    });
  }
}
