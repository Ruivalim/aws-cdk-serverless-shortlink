#!/usr/bin/env node
import 'source-map-support/register';
import { App, Tags } from 'aws-cdk-lib';
import { ApiStack } from '../lib/stacks/api-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { ObservabilityStack } from '../lib/stacks/observability-stack';

const app = new App();

const region = process.env.CDK_TARGET_REGION ?? 'us-east-1';
const account = process.env.CDK_TARGET_ACCOUNT;

/**
 * Deliberately agnostic unless a target is given explicitly.
 *
 * Do not bind this to `CDK_DEFAULT_ACCOUNT`/`CDK_DEFAULT_REGION`: the CDK CLI
 * fills those in from whatever profile is active on the machine, which pins the
 * stack to one environment whether you meant it or not. Opt in with
 * CDK_TARGET_ACCOUNT and CDK_TARGET_REGION when you want that.
 */
const env = account ? { account, region } : undefined;

/**
 * Environments are declared explicitly rather than passed as free-form
 * arguments, so an unknown environment name fails at synth time instead of
 * silently creating a half-configured stack.
 */
const environments = {
  dev: {},
  prod: {},
} as const;

type EnvironmentName = keyof typeof environments;

const environment = (app.node.tryGetContext('environment') ?? 'dev') as EnvironmentName;

if (!(environment in environments)) {
  throw new Error(
    `Unknown environment "${environment}". Use one of: ${Object.keys(environments).join(', ')}.`,
  );
}

const stackProps = {
  env,
  environment,
  description: `Short-link service (${environment})`,
};

// Storage, then the request path, then the alarms. The split exists so the
// table can be retained and restored independently: deleting the API stack
// must never touch a customer's links.
const data = new DataStack(app, `shortlink-data-${environment}`, stackProps);

const api = new ApiStack(app, `shortlink-api-${environment}`, {
  ...stackProps,
  linksTable: data.linksTable,
});

new ObservabilityStack(app, `shortlink-observability-${environment}`, {
  ...stackProps,
  functions: [
    { label: 'create-link', fn: api.createLinkFn.fn },
    { label: 'redirect', fn: api.redirectFn.fn },
    { label: 'click-consumer', fn: api.clickConsumerFn.fn },
  ],
  deadLetterQueue: api.clickQueue.deadLetterQueue,
  httpApi: api.httpApi.api,
  // Optional: set ALARM_EMAIL to get an email subscription on the alarm topic.
  alarmEmail: process.env.ALARM_EMAIL,
});

// Tag every resource in the app, so cost allocation reports work from day one.
Tags.of(app).add('Project', 'shortlink');
Tags.of(app).add('Environment', environment);
Tags.of(app).add('ManagedBy', 'aws-cdk');
