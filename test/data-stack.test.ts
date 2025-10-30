import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DataStack } from '../lib/stacks/data-stack';

/**
 * Builds a DataStack in isolation. Tests never synth the real app: that would
 * couple them to every stack in `bin/app.ts` and make the failure output
 * useless.
 */
function synth(environment: 'dev' | 'prod' = 'dev'): Template {
  const app = new App();
  const stack = new DataStack(app, `test-data-${environment}`, {
    environment,
    env: { account: '111111111111', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

/** The shape of a resource as it appears in a synthesized CloudFormation template. */
interface CfnResource {
  Type: string;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
}

/**
 * `Template.toJSON()` types `Resources` as `any`, which would leak unsafe
 * access into every assertion. Narrowing it once here keeps the tests typed.
 */
function resourcesOfType(template: Template, type: string): CfnResource[] {
  const resources = template.toJSON().Resources as Record<string, CfnResource>;
  return Object.values(resources).filter((resource) => resource.Type === type);
}

describe('DataStack', () => {
  test('creates exactly one DynamoDB table, on-demand billed', () => {
    const template = synth();

    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    });
  });

  test('enables TTL on expiresAt and point-in-time recovery', () => {
    const template = synth();

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  test('defines the gsi1 and gsi2 access-pattern indexes', () => {
    const template = synth();

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'gsi2',
          KeySchema: [{ AttributeName: 'gsi2pk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'KEYS_ONLY' },
        },
      ],
    });
  });

  test('names the table per environment', () => {
    expect(JSON.stringify(synth('dev').toJSON())).toContain('shortlink-links-dev');
    expect(JSON.stringify(synth('prod').toJSON())).toContain('shortlink-links-prod');
  });

  test('retains the table in prod and destroys it in dev', () => {
    // DeletionPolicy is the difference between "cdk destroy cleaned up my dev
    // environment" and "I just deleted production links".
    const prodTables = resourcesOfType(synth('prod'), 'AWS::DynamoDB::Table');
    expect(prodTables).toHaveLength(1);
    expect(prodTables[0].DeletionPolicy).toBe('Retain');

    const devTables = resourcesOfType(synth('dev'), 'AWS::DynamoDB::Table');
    expect(devTables).toHaveLength(1);
    expect(devTables[0].DeletionPolicy).toBe('Delete');
  });

  test('does not grant dynamodb permissions to anyone yet', () => {
    // This slice of the app has no consumers. If this starts failing, a grant
    // was added without the matching consumer, or a policy was hand-rolled
    // instead of going through the LinksTable grant helpers.
    synth().resourceCountIs('AWS::IAM::Policy', 0);
  });
});
