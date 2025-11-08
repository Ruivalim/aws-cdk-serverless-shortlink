import { Duration, RemovalPolicy } from 'aws-cdk-lib';
// `AccessLogFormat` is defined by the REST API module and only re-used by the
// HTTP API one; aws-apigatewayv2 does not re-export it.
import { AccessLogFormat } from 'aws-cdk-lib/aws-apigateway';
import {
  CorsHttpMethod,
  HttpApi as CdkHttpApi,
  HttpStage,
  LogGroupLogDestination,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * Props for {@link HttpApi}.
 */
export interface HttpApiProps {
  /** Name of the API. Also used to name the access log group. */
  readonly apiName: string;

  /**
   * Stage name.
   *
   * @default '$default'
   */
  readonly stageName?: string;

  /**
   * Steady-state request rate allowed per second across the stage. A hard
   * ceiling here is what protects the Lambdas from a traffic spike and the bill
   * that comes with it.
   *
   * @default 100
   */
  readonly throttlingRateLimit?: number;

  /**
   * Short-lived burst allowance above `throttlingRateLimit`.
   *
   * @default 200
   */
  readonly throttlingBurstLimit?: number;

  /**
   * @default RetentionDays.TWO_WEEKS
   */
  readonly logRetention?: RetentionDays;
}

/**
 * An HTTP API (API Gateway v2) with the defaults this project uses.
 *
 * HTTP API rather than REST API: the REST API charges roughly 3.5x per million
 * requests and buys features this service does not use (request validation
 * models, API keys, usage plans). The redirect path is pure proxy work.
 *
 * Two things are deliberate and worth naming:
 *
 * - **Not the default stage.** `createDefaultStage: false` plus an explicit
 *   `HttpStage` is the only way to attach access logs and throttling. The
 *   auto-created default stage supports neither.
 * - **Access logs on.** Without them, a 5xx from the API layer is invisible in
 *   CloudWatch; you only see the Lambda's side of the story.
 */
export class HttpApi extends Construct {
  /** The underlying HTTP API. Attach routes to this. */
  public readonly api: CdkHttpApi;

  /** Access log group, so the Observability stack can alarm on it. */
  public readonly accessLogGroup: LogGroup;

  constructor(scope: Construct, id: string, props: HttpApiProps) {
    super(scope, id);

    this.accessLogGroup = new LogGroup(this, 'AccessLogs', {
      logGroupName: `/aws/apigateway/${props.apiName}`,
      retention: props.logRetention ?? RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.api = new CdkHttpApi(this, 'Api', {
      apiName: props.apiName,
      createDefaultStage: false,
      corsPreflight: {
        // A short-link API is public by design: the browser-side form on any
        // origin has to be able to POST /links.
        allowOrigins: ['*'],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.OPTIONS],
        maxAge: Duration.hours(1),
      },
    });

    new HttpStage(this, 'Stage', {
      httpApi: this.api,
      stageName: props.stageName ?? '$default',
      autoDeploy: true,
      throttle: {
        rateLimit: props.throttlingRateLimit ?? 100,
        burstLimit: props.throttlingBurstLimit ?? 200,
      },
      accessLogSettings: {
        destination: new LogGroupLogDestination(this.accessLogGroup),
        format: AccessLogFormat.jsonWithStandardFields(),
      },
    });
  }
}
