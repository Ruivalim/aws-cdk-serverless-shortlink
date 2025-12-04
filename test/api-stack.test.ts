import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ApiStack } from '../lib/stacks/api-stack';
import { DataStack } from '../lib/stacks/data-stack';

/**
 * Synthesizes the data stack and the API stack together, because the API's
 * whole job is to be wired to the table. The data stack is synthesized but only
 * the API template is asserted on.
 */
function synth(environment: 'dev' | 'prod' = 'dev'): Template {
  const app = new App();
  const env = { account: '111111111111', region: 'us-east-1' };

  const data = new DataStack(app, `test-data-${environment}`, { environment, env });

  const api = new ApiStack(app, `test-api-${environment}`, {
    environment,
    env,
    linksTable: data.linksTable,
  });

  return Template.fromStack(api);
}

interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
}

interface IamStatement {
  Action?: unknown;
  Resource?: unknown;
}

type ResourceMap = Record<string, CfnResource>;

function resourceMap(template: Template): ResourceMap {
  return template.toJSON().Resources as ResourceMap;
}

function resourcesOfType(template: Template, type: string): CfnResource[] {
  return Object.values(resourceMap(template)).filter((resource) => resource.Type === type);
}

/** Collects every statement from every inline IAM policy in the template. */
function iamStatements(template: Template): IamStatement[] {
  return resourcesOfType(template, 'AWS::IAM::Policy').flatMap((policy) => {
    const document = policy.Properties?.PolicyDocument as
      { Statement?: IamStatement[] } | undefined;
    return document?.Statement ?? [];
  });
}

function actionsOf(statement: IamStatement): string[] {
  const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
  return actions.filter((action): action is string => typeof action === 'string');
}

function resourcesOf(statement: IamStatement): unknown[] {
  return Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
}

/** The logical id of the role a function runs as. */
function roleLogicalId(function_: CfnResource): string | undefined {
  const role = function_.Properties?.Role as { 'Fn::GetAtt'?: [string, string] } | undefined;
  return role?.['Fn::GetAtt']?.[0];
}

/**
 * Every IAM action the named function can perform.
 *
 * Resolves function to role to inline policy, so an assertion can be about one
 * function's permissions rather than about the union of all of them. That
 * union is exactly what hides a privilege that leaked onto the wrong function.
 */
function actionsForFunction(template: Template, functionName: string): string[] {
  const resources = resourceMap(template);

  const target = Object.values(resources).find(
    (resource) =>
      resource.Type === 'AWS::Lambda::Function' &&
      resource.Properties?.FunctionName === functionName,
  );

  if (!target) {
    throw new Error(`No function named ${functionName} in the template.`);
  }

  const roleId = roleLogicalId(target);
  if (!roleId) {
    throw new Error(`Function ${functionName} has no role.`);
  }

  return Object.values(resources)
    .filter((resource) => resource.Type === 'AWS::IAM::Policy')
    .filter((policy) => {
      const roles = policy.Properties?.Roles as Array<{ Ref?: string }> | undefined;
      return (roles ?? []).some((role) => role.Ref === roleId);
    })
    .flatMap((policy) => {
      const document = policy.Properties?.PolicyDocument as
        { Statement?: IamStatement[] } | undefined;
      return (document?.Statement ?? []).flatMap(actionsOf);
    });
}

describe('ApiStack', () => {
  test('creates one function per handler', () => {
    synth().resourceCountIs('AWS::Lambda::Function', 3);
  });

  test.each([
    ['create-link', 'shortlink-create-link-dev'],
    ['redirect', 'shortlink-redirect-dev'],
    ['click-consumer', 'shortlink-click-consumer-dev'],
  ])('names the %s function per environment', (_label, functionName) => {
    synth().hasResourceProperties('AWS::Lambda::Function', { FunctionName: functionName });
  });

  test('runs every function on arm64 with tracing enabled', () => {
    const functions = resourcesOfType(synth(), 'AWS::Lambda::Function');

    expect(functions).toHaveLength(3);

    for (const fn of functions) {
      expect(fn.Properties?.Architectures).toEqual(['arm64']);
      expect(fn.Properties?.Runtime).toBe('nodejs24.x');
      expect(fn.Properties?.TracingConfig).toEqual({ Mode: 'Active' });
    }
  });

  test('gives every function a log group with a retention', () => {
    // An unbounded log group is a bill that shows up months later.
    synth().resourceCountIs('AWS::Logs::LogGroup', 4); // three functions, one API access log
    synth().hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 14 });
  });

  test('exposes POST /links and GET /{code}', () => {
    const template = synth();

    template.resourceCountIs('AWS::ApiGatewayV2::Route', 2);
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /links',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /{code}',
    });
  });

  test('throttles the stage', () => {
    synth().hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 },
    });
  });

  test('raises the throttle ceiling in production', () => {
    synth('prod').hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: { ThrottlingRateLimit: 500, ThrottlingBurstLimit: 1000 },
    });
  });

  test('creates the click queue and its dead-letter queue', () => {
    const template = synth();

    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'shortlink-clicks-dev',
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'shortlink-clicks-dev-dlq',
    });
  });

  test('wires the consumer with partial batch failure reporting', () => {
    // Without ReportBatchItemFailures, the handler's batchItemFailures return
    // value is ignored and any failure replays the whole batch.
    const template = synth();

    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      BatchSize: 10,
    });
  });

  test('scopes every resource, except where AWS does not support scoping', () => {
    // X-Ray's PutTraceSegments and PutTelemetryRecords do not accept
    // resource-level permissions, so `*` there is required rather than a
    // finding. Every other wildcard is a real one.
    const unscopable = new Set(['xray:PutTraceSegments', 'xray:PutTelemetryRecords']);
    const offenders: string[][] = [];

    for (const statement of iamStatements(synth())) {
      if (!resourcesOf(statement).includes('*')) {
        continue;
      }

      const unexpected = actionsOf(statement).filter((action) => !unscopable.has(action));
      if (unexpected.length > 0) {
        offenders.push(unexpected);
      }
    }

    expect(offenders).toEqual([]);
  });

  test('grants no wildcard dynamodb action', () => {
    const broadDynamo = iamStatements(synth())
      .flatMap(actionsOf)
      .filter((action) => action.startsWith('dynamodb:') && action.includes('*'));

    expect(broadDynamo).toEqual([]);
  });

  test('gives each function its own role', () => {
    // One shared role would make every function able to do everything the
    // others can, which defeats the scoped grants below.
    const roleRefs = resourcesOfType(synth(), 'AWS::Lambda::Function').map(roleLogicalId);

    expect(roleRefs).toHaveLength(3);
    expect(roleRefs.every((ref) => typeof ref === 'string')).toBe(true);
    expect(new Set(roleRefs).size).toBe(3);
  });

  test('keeps create-link away from the queue entirely', () => {
    // It writes links and nothing else. If this starts failing, a grant was
    // added to the wrong construct.
    const actions = actionsForFunction(synth(), 'shortlink-create-link-dev');

    expect(actions.filter((action) => action.startsWith('sqs:'))).toEqual([]);
  });

  test('lets the redirect function publish to the queue but not consume from it', () => {
    const actions = actionsForFunction(synth(), 'shortlink-redirect-dev');

    expect(actions).toContain('sqs:SendMessage');
    expect(actions).not.toContain('sqs:ReceiveMessage');
    expect(actions).not.toContain('sqs:DeleteMessage');
  });

  test('lets the consumer consume from the queue but not publish to it', () => {
    const actions = actionsForFunction(synth(), 'shortlink-click-consumer-dev');

    expect(actions).toContain('sqs:ReceiveMessage');
    expect(actions).toContain('sqs:DeleteMessage');
    expect(actions).not.toContain('sqs:SendMessage');
  });
});
