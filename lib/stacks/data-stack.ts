import type { StackProps } from 'aws-cdk-lib';
import { Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { LinksTable } from '../constructs/links-table';

export interface DataStackProps extends StackProps {
  /** Environment name, used for resource naming (`dev`, `prod`). */
  readonly environment: string;
}

/**
 * Owns everything that stores state: the links table today, and later the
 * click-record table or archive bucket.
 *
 * Data lives in its own stack so it can be retained, snapshot-restored and
 * capacity-planned independently from the compute that reads it. Deleting the
 * API stack must never touch a customer's links.
 */
export class DataStack extends Stack {
  public readonly linksTable: LinksTable;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const isProduction = props.environment === 'prod';

    this.linksTable = new LinksTable(this, 'Links', {
      tableName: `shortlink-links-${props.environment}`,
      ttlDays: isProduction ? 365 : 7,
      destroyOnStackRemoval: !isProduction,
    });
  }
}
