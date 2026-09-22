# aws-cdk-serverless-shortlink

A URL shortener on AWS, defined entirely in TypeScript with the AWS CDK.

This is not a `cdk init` demo. It is the shape a real service takes: separate
stacks for state and compute, a single-table DynamoDB design with the access
patterns written down, scoped IAM grants, a dead-letter queue, alarms that
actually notify, and a test suite that asserts on the synthesized template
rather than on the code that produces it.

<!-- The badge renders once the repository is public. -->

[![CI](https://github.com/Ruivalim/aws-cdk-serverless-shortlink/actions/workflows/ci.yml/badge.svg)](https://github.com/Ruivalim/aws-cdk-serverless-shortlink/actions/workflows/ci.yml)

## Architecture

```
                        POST /links                      GET /{code}
                             │                                │
                             ▼                                ▼
                  ┌──────────────────────────────────────────────────┐
                  │              API Gateway (HTTP API v2)           │
                  │      throttling · CORS · JSON access logs        │
                  └───────────┬──────────────────────┬───────────────┘
                              │                      │
                              ▼                      ▼
                    ┌──────────────────┐   ┌──────────────────┐
                    │   create-link    │   │     redirect     │
                    │   Lambda arm64   │   │   Lambda arm64   │
                    └────────┬─────────┘   └───┬──────────┬───┘
                             │                 │          │ 301 + click event
                             │                 │          ▼
                             │                 │    ┌───────────┐      ┌───────┐
                             │                 │    │    SQS    │─ ─ ─▶│  DLQ  │
                             │                 │    └─────┬─────┘      └───────┘
                             ▼                 ▼          ▼
                    ┌─────────────────────────────────────────────────┐
                    │         DynamoDB  (single table, on-demand)      │
                    │   links · clicks · gsi1 (by owner) · gsi2 (URL)  │
                    └─────────────────────────────────────────────────┘
                                           ▲
                                           │
                                  ┌──────────────────┐
                                  │  click-consumer  │
                                  │   Lambda arm64   │
                                  └──────────────────┘

        CloudWatch: 8 alarms (errors, throttles, DLQ backlog, API 5xx) + dashboard
```

Three stacks, deliberately:

| Stack                       | Owns                     | Why separate                                                                                          |
| --------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `shortlink-data-*`          | The DynamoDB table       | State outlives compute. `cdk destroy` on the API must never touch a link. Dev destroys, prod retains. |
| `shortlink-api-*`           | HTTP API, Lambdas, SQS   | The request path. Replaced freely.                                                                    |
| `shortlink-observability-*` | Alarms, topic, dashboard | Alarms can be changed during an incident without redeploying the thing that is on fire.               |

## API

### `POST /links`

```bash
curl -X POST "$API_URL/links" \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/a/very/long/path","ttlDays":30}'
```

```json
{
  "code": "aB3xY9z",
  "url": "https://example.com/a/very/long/path",
  "shortUrl": "https://abc123.execute-api.us-east-1.amazonaws.com/aB3xY9z",
  "expiresAt": 1790000000
}
```

`201` on create, `200` when the same URL was already shortened (`ttlDays` is
optional, defaults to 30, maximum 3650).

### `GET /{code}`

`301` with a `Location` header. `404` if no link matches, `410` if the link
existed and expired.

## Running it

Requires Node 24 (see `.nvmrc`) and no AWS account to build or test.

```bash
npm ci
npm run check        # formatting, lint, compile, 97 tests
npx cdk synth -c environment=dev
```

`npm run check` is the whole gate. It runs `fmt:check`, `lint`, `build` and
`test` in that order.

### Deploying

Deploy is documented rather than automated, because it needs credentials and a
bootstrap that belong to whoever owns the account. Nothing here depends on an
account until you actually deploy.

```bash
# One time per account/region.
npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1

# Point the app at a concrete account and region, then deploy.
export CDK_TARGET_ACCOUNT=<ACCOUNT_ID>
export CDK_TARGET_REGION=us-east-1
npx cdk deploy --all -c environment=dev

# Optional: get an email when an alarm fires.
export ALARM_EMAIL=you@example.com
```

Tear everything down with `npx cdk destroy --all -c environment=dev`.

The account is opt-in on purpose. Binding the stack to `CDK_DEFAULT_ACCOUNT`,
which the CDK CLI fills in from whatever profile is active on your machine,
makes the stack environment-specific. An environment-specific stack resolves
its availability zones with a live `DescribeAvailabilityZones` call, which
needs credentials, breaks `cdk synth` in CI, and writes the caller's account id
into `cdk.context.json`. Naming the zones explicitly avoids all three.

## Layout

```
bin/app.ts                       entry point: environments, stacks, tags
lib/constructs/                  reusable L3 pieces
  lambda-function.ts               NodejsFunction with the house defaults
  http-api.ts                      HTTP API with logs and throttling
  click-queue.ts                   SQS + dead-letter queue
  links-table.ts                   single-table DynamoDB with its indexes
lib/stacks/
  data-stack.ts                    the table
  api-stack.ts                     the request path and every grant
  observability-stack.ts           alarms, topic, dashboard
src/handlers/                    the three Lambda entry points
src/lib/                         key layout, validation, responses, clients
test/                            template assertions, invariants, handler tests
```

## Design decisions

**One table, three access patterns.** Links are `pk = LINK#<code>` with
`gsi1pk = OWNER#<id>` (list a user's links, sorted) and `gsi2pk = URL#<sha256>`
(look a URL up by its hash). The second index is what makes creation
idempotent: submitting the same URL twice returns the existing code instead of
allocating a new one.

**Codes are written, never overwritten.** The insert carries
`attribute_not_exists(pk)`, so a collision fails the write instead of
clobbering an existing link. The handler redraws and retries; after three
attempts it returns `503` rather than looping. Seven base62 characters is
about 3.5 trillion codes, and the draw uses rejection sampling so the first
four alphabet characters are not slightly over-represented.

**Analytics never blocks a redirect.** The click event is published to SQS as
a side effect, and a failure to publish is logged and swallowed. If SQS is
throttling, the user still reaches their destination and one click goes
uncounted. That is the right trade: the alternative is an analytics outage
becoming a product outage.

**Only `http` and `https` are accepted.** A redirect endpoint that forwards any
scheme is an open redirector, and `javascript:` and `data:` are real attacks in
a browser, not a validation nicety.

**IAM is scoped and tested.** Every grant goes through a construct helper, and
the test suite asserts the split: `create-link` has no SQS permission at all,
`redirect` can send but not receive, `click-consumer` can receive but not send.
One test fails if any policy statement gains a wildcard resource, except for
the two X-Ray actions that do not support resource-level permissions.

**`defaultCapacity: 0` does not exist here.** Node capacity, concurrency and
memory are declared where they are used, never inherited from a CDK default
that is hard to find and harder to tune.

## Known limitations

These are real and worth naming rather than hiding:

- **Clicks are counted on a 301, so they are undercounted.** A browser that
  caches the redirect never reaches the function and never emits a click
  event. `301` is semantically right for a permanent mapping; if exact counts
  matter more than cacheability, the redirect should return `302`. The handler
  accepts either.
- **The click counter can double-count.** It is an unconditional `ADD`, so a
  redelivered message increments it twice. An exactly-once counter would need a
  conditional write per click, which is a lot of coordination for telemetry.
- **No custom domain.** The service answers on the API Gateway URL. Adding one
  means Route 53, an ACM certificate and a domain mapping on the stage.
- **No authentication.** Anyone who can reach the API can create a link. An
  authorizer (Cognito or a Lambda authorizer) belongs in front of `POST /links`
  before this is exposed to real traffic.

## Cost

At portfolio traffic (a few thousand requests a month) this runs at
effectively zero:

| Resource             | Cost                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| Lambda               | Free tier covers 1M requests and 400k GB-s                           |
| API Gateway HTTP API | $1 per million requests                                              |
| DynamoDB on-demand   | $1.25 per million writes, $0.25 per million reads                    |
| SQS                  | $0.40 per million requests                                           |
| CloudWatch logs      | The only unavoidable line. Two-week retention is what keeps it small |

The alarms and the dashboard are free. The main way to make this expensive is
to leave a log group with no retention, which is why every function gets one
with a 14-day window and `cdk destroy` actually removes it.

## License

MIT
