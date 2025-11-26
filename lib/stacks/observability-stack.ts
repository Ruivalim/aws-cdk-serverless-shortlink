import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type { IHttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import {
  Alarm,
  ComparisonOperator,
  Dashboard,
  GraphWidget,
  TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import type { IQueue } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/** A function to alarm on, with the label used in alarm and widget names. */
export interface ObservableFunction {
  readonly label: string;
  readonly fn: IFunction;
}

export interface ObservabilityStackProps extends StackProps {
  /** Environment name, used for resource naming (`dev`, `prod`). */
  readonly environment: string;

  /** Functions to alarm on, keyed by a human label. */
  readonly functions: ObservableFunction[];

  /** The queue whose backlog is worth waking up for. */
  readonly deadLetterQueue: IQueue;

  /** The API to alarm on. */
  readonly httpApi: IHttpApi;

  /**
   * Address to notify when an alarm fires. Without it the stack still creates
   * the alarms and the topic, but nobody is told; that is a deliberate default
   * rather than a forgotten configuration.
   */
  readonly alarmEmail?: string;
}

/**
 * Alarms, a notification topic, and a dashboard.
 *
 * Lives in its own stack so the alarm wiring can be reviewed and changed
 * without touching the request path, and so an incident is not blocked behind
 * a deploy of the service it is reporting on.
 *
 * The alarms all use `TreatMissingData.NOT_BREACHING`. A function that has not
 * been invoked in the last five minutes has no error metric, and treating that
 * absence as a breach would page someone every quiet night.
 */
export class ObservabilityStack extends Stack {
  /** Where alarms are published. */
  public readonly alarmTopic: Topic;

  /** The dashboard URL, for a README or a runbook. */
  public readonly dashboardUrl: string;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const { environment } = props;

    this.alarmTopic = new Topic(this, 'AlarmTopic', {
      topicName: `shortlink-alarms-${environment}`,
      displayName: 'Short-link alarms',
    });

    if (props.alarmEmail) {
      this.alarmTopic.addSubscription(new EmailSubscription(props.alarmEmail));
    }

    const notify = new SnsAction(this.alarmTopic);

    for (const { label, fn } of props.functions) {
      const errors = new Alarm(this, `Errors${label}`, {
        alarmName: `shortlink-${environment}-${label}-errors`,
        alarmDescription: `${label} returned errors.`,
        metric: fn.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      errors.addAlarmAction(notify);

      const throttles = new Alarm(this, `Throttles${label}`, {
        alarmName: `shortlink-${environment}-${label}-throttles`,
        alarmDescription: `${label} is being throttled; concurrency or a quota needs attention.`,
        metric: fn.metricThrottles({ period: Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      throttles.addAlarmAction(notify);
    }

    const dlqBacklog = new Alarm(this, 'DeadLetterBacklog', {
      alarmName: `shortlink-${environment}-dlq-not-empty`,
      alarmDescription:
        'Click events failed repeatedly and were moved to the dead-letter queue. Analytics is undercounting.',
      metric: props.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    dlqBacklog.addAlarmAction(notify);

    const serverErrors = new Alarm(this, 'ApiServerErrors', {
      alarmName: `shortlink-${environment}-api-5xx`,
      alarmDescription: 'The API returned 5xx responses to clients.',
      metric: props.httpApi.metricServerError({
        period: Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    serverErrors.addAlarmAction(notify);

    const dashboard = new Dashboard(this, 'Dashboard', {
      dashboardName: `shortlink-${environment}`,
    });

    dashboard.addWidgets(
      new GraphWidget({
        title: 'Requests',
        width: 12,
        left: [props.httpApi.metricCount(), props.httpApi.metricServerError()],
      }),
      new GraphWidget({
        title: 'Latency (p99)',
        width: 12,
        left: [props.httpApi.metricLatency({ statistic: 'p99' })],
      }),
    );

    dashboard.addWidgets(
      new GraphWidget({
        title: 'Function errors',
        width: 12,
        left: props.functions.map(({ fn }) => fn.metricErrors()),
      }),
      new GraphWidget({
        title: 'Click queue backlog',
        width: 12,
        left: [props.deadLetterQueue.metricApproximateNumberOfMessagesVisible()],
      }),
    );

    this.dashboardUrl = `https://${this.region}.console.aws.amazon.com/cloudwatch/home#dashboards:name=${dashboard.dashboardName}`;
  }
}
