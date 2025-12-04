import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ApiStack } from '../lib/stacks/api-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { ObservabilityStack } from '../lib/stacks/observability-stack';

/**
 * Synthesizes the whole app and asserts on the observability stack.
 *
 * The alarm wiring cannot be tested in isolation: the alarms exist to watch
 * the functions, so a stack without them would assert nothing meaningful.
 */
function synth(alarmEmail?: string): Template {
  const app = new App();
  const env = { account: '111111111111', region: 'us-east-1' };
  const environment = 'dev';

  const data = new DataStack(app, 'test-data', { environment, env });

  const api = new ApiStack(app, 'test-api', {
    environment,
    env,
    linksTable: data.linksTable,
  });

  const observability = new ObservabilityStack(app, 'test-observability', {
    environment,
    env,
    functions: [
      { label: 'create-link', fn: api.createLinkFn.fn },
      { label: 'redirect', fn: api.redirectFn.fn },
      { label: 'click-consumer', fn: api.clickConsumerFn.fn },
    ],
    deadLetterQueue: api.clickQueue.deadLetterQueue,
    httpApi: api.httpApi.api,
    alarmEmail,
  });

  return Template.fromStack(observability);
}

interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
}

function resourcesOfType(template: Template, type: string): CfnResource[] {
  const resources = template.toJSON().Resources as Record<string, CfnResource>;
  return Object.values(resources).filter((resource) => resource.Type === type);
}

describe('ObservabilityStack', () => {
  test('creates two alarms per function, plus the queue and API alarms', () => {
    // 3 functions x (errors + throttles) + dead-letter backlog + API 5xx.
    synth().resourceCountIs('AWS::CloudWatch::Alarm', 8);
  });

  test('names each alarm after the environment and the thing it watches', () => {
    const template = synth();

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'shortlink-dev-redirect-errors',
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'shortlink-dev-redirect-throttles',
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'shortlink-dev-dlq-not-empty',
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'shortlink-dev-api-5xx',
    });
  });

  test('never treats missing data as a breach', () => {
    // A service nobody called in the last five minutes has no error metric. The
    // default (missing data is a breach) would page someone every quiet night.
    const alarms = resourcesOfType(synth(), 'AWS::CloudWatch::Alarm');

    expect(alarms).toHaveLength(8);
    for (const alarm of alarms) {
      expect(alarm.Properties?.TreatMissingData).toBe('notBreaching');
    }
  });

  test('fires as soon as there is a single error, not a percentage', () => {
    const template = synth();

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'shortlink-dev-api-5xx',
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 1,
    });
  });

  test('every alarm notifies the topic', () => {
    // An alarm with no action is a dashboard decoration.
    const alarms = resourcesOfType(synth(), 'AWS::CloudWatch::Alarm');
    const withoutActions = alarms.filter((alarm) => {
      const actions = alarm.Properties?.AlarmActions;
      return !Array.isArray(actions) || actions.length === 0;
    });

    expect(withoutActions).toEqual([]);
  });

  test('creates the alarm topic per environment', () => {
    const template = synth();

    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'shortlink-alarms-dev',
    });
  });

  test('creates the dashboard per environment', () => {
    const template = synth();

    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: 'shortlink-dev',
    });
  });

  test('subscribes the alarm address when one is given', () => {
    synth('ops@example.com').hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'ops@example.com',
    });
  });

  test('creates no subscription when no address is given', () => {
    // Deliberate: the alarms and the topic exist, but nobody is told until an
    // address is configured. That is a decision, not an oversight.
    synth().resourceCountIs('AWS::SNS::Subscription', 0);
  });
});
