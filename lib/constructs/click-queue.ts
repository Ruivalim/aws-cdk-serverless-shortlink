import { Duration } from 'aws-cdk-lib';
import type { IGrantable } from 'aws-cdk-lib/aws-iam';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

/**
 * Props for {@link ClickQueue}.
 */
export interface ClickQueueProps {
  /** Base name. The dead-letter queue gets a `-dlq` suffix. */
  readonly queueName: string;

  /**
   * Visibility timeout for the main queue.
   *
   * Must be at least the consumer's timeout, or a message becomes visible again
   * while the first invocation is still working, and the click is processed
   * twice. The default here is deliberately three times the consumer's.
   *
   * @default Duration.seconds(30)
   */
  readonly visibilityTimeout?: Duration;
}

/**
 * The queue that carries click events from the redirect handler to the
 * consumer.
 *
 * A dead-letter queue is not optional. Click telemetry is the only thing on
 * this queue, so a poison message (malformed JSON from a bug, an unexpected
 * schema) would otherwise be retried until the retention window closes,
 * burning invocations the whole time.
 */
export class ClickQueue extends Construct {
  /** The main queue. The redirect handler sends here. */
  public readonly queue: Queue;

  /** Where messages land after repeated failures. */
  public readonly deadLetterQueue: Queue;

  constructor(scope: Construct, id: string, props: ClickQueueProps) {
    super(scope, id);

    this.deadLetterQueue = new Queue(this, 'Dlq', {
      queueName: `${props.queueName}-dlq`,
      // Outlives the main queue, so a failure is still inspectable after the
      // original message expired.
      retentionPeriod: Duration.days(14),
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    this.queue = new Queue(this, 'Resource', {
      queueName: props.queueName,
      visibilityTimeout: props.visibilityTimeout ?? Duration.seconds(30),
      retentionPeriod: Duration.days(4),
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 5,
      },
    });
  }

  /** Allow the redirect handler to enqueue a click. Read access is not implied. */
  public grantSend(grantee: IGrantable): void {
    this.queue.grantSendMessages(grantee);
  }

  /** Allow the consumer to poll, delete, and read the dead-letter queue. */
  public grantConsume(grantee: IGrantable): void {
    this.queue.grantConsumeMessages(grantee);
    this.deadLetterQueue.grantConsumeMessages(grantee);
  }
}
