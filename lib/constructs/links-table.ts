import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
  TableEncryption,
} from 'aws-cdk-lib/aws-dynamodb';
import type { IGrantable } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';

/**
 * Props for {@link LinksTable}.
 */
export interface LinksTableProps {
  /**
   * Name of the DynamoDB table. CDK appends a unique suffix by default
   * unless `tableName` is pinned, so keep this short.
   */
  readonly tableName: string;

  /**
   * Retention for expired links, in days. Items whose `expiresAt` (Unix epoch
   * seconds) is in the past are removed by DynamoDB TTL at no cost.
   *
   * @default 30
   */
  readonly ttlDays?: number;

  /**
   * Whether to keep the table when the stack is deleted.
   *
   * This is deliberately `false` by default: losing short links on a stray
   * `cdk destroy` is a bad first experience. Set to `true` in throwaway
   * environments where you want the stack to clean up after itself.
   *
   * @default false
   */
  readonly destroyOnStackRemoval?: boolean;
}

/**
 * Short-link storage: a single-table design keyed by the short code.
 *
 * Access patterns this table serves:
 *
 * | Pattern                        | Key condition                          |
 * | ------------------------------ | -------------------------------------- |
 * | Resolve a short code           | `pk = LINK#<code>`                     |
 * | List links owned by a user     | `gsi1pk = OWNER#<userId>`, sorted desc |
 * | Look up an existing long URL   | `gsi2pk = URL#<sha256(url)>`           |
 *
 * The `urlHash` GSI is what makes `createLink` idempotent: the same long URL
 * submitted twice returns the existing short code instead of allocating a new
 * one.
 */
export class LinksTable extends Construct {
  /** The underlying table. Prefer the narrow helpers below where they fit. */
  public readonly table: Table;

  /** Number of days after which a link expires, from `ttlDays`. */
  public readonly ttlDays: number;

  constructor(scope: Construct, id: string, props: LinksTableProps) {
    super(scope, id);

    this.ttlDays = props.ttlDays ?? 30;

    this.table = new Table(this, 'Resource', {
      tableName: props.tableName,
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: props.destroyOnStackRemoval ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });

    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // Query-only GSI: covers idempotency lookups, no need to project payloads.
    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi2',
      partitionKey: { name: 'gsi2pk', type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });
  }

  /**
   * Grant read access to a link resolver. Scoped to the table and its GSIs, not
   * `dynamodb:*` on `*`.
   */
  public grantRead(grantee: IGrantable): void {
    this.table.grantReadData(grantee);
  }

  /**
   * Grant read plus write access to a link creator, which must read the
   * `urlHash` index before inserting.
   */
  public grantReadWrite(grantee: IGrantable): void {
    this.table.grantReadWriteData(grantee);
  }

  /**
   * Grant write-only access for the click consumer. It appends click records
   * but never needs to read links back.
   */
  public grantWrite(grantee: IGrantable): void {
    this.table.grantWriteData(grantee);
  }

  /** Seconds until a link created *now* should expire. */
  public expirationSeconds(nowEpochSeconds: number): number {
    return nowEpochSeconds + Duration.days(this.ttlDays).toSeconds();
  }
}
