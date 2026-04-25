# API surface

Every public symbol exported from `mailbox-station` and `gmail-station`. If a user-supplied symbol isn't in this file, it doesn't exist.

## `mailbox-station` exports

### Factory + types

```ts
createStation<P extends Record<string, ProviderFactory>>(input: StationInput<P>): Station<P>

type StationInput<P> = {
  store:    StoreAdapter
  handler:  MessageHandlerFn
  config?:  WorkerConfig         // worker concurrency, backoff, etc.
  providers: P                   // typed map; v1 must have exactly 1 key
  logger?:  StationLogger        // defaults to consoleLogger
}

type Station<P> = {
  start(): Promise<void>
  stop():  Promise<void>
  wait():  Promise<void>
  readonly providers: ProviderApis<P>   // station.providers.gmail.register(...) etc.
  readonly pipeline:  MailboxPipeline
}
```

### Result type

```ts
type Result<T, E> =
  | { ok: true;  value: T }
  | { ok: false; error: E }

const ok  = <T>(value: T) => ({ ok: true, value })
const err = <E>(error: E) => ({ ok: false, error })

isOk, isErr            // type guards
map, mapErr            // value/error transforms
```

### Branded IDs

```ts
AccountId, JobId, MessageId, ThreadId, UserId      // value-side smart constructors
AccountIdType, JobIdType, MessageIdType, ThreadIdType, UserIdType   // type aliases
newAccountId()                                      // crypto.randomUUID-backed
```

Use the constructors to produce branded values: `UserId("user-1")` returns the branded string.

### Backoff

```ts
defaultBackoff: BackoffConfig = { baseMs: 30_000, factor: 2, maxMs: 5*60_000, jitterFactor: 0.25 }
nextAttemptDelayMs(attempts, config, random?): number
computeNextAttemptAt(now, attempts, config, random?): Date
```

Curve with defaults: 30s, 1m, 2m, 4m, 5m, 5m, … (capped) ±25% jitter.

### Logger

```ts
consoleLogger        // JSON-line stdout
noopLogger           // discards everything

interface StationLogger {
  debug(event: string, fields?: Record<string, unknown>): void
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}
```

### Data model

```ts
type EmailAddress = { name: string | null; email: string }

type AttachmentRef = {
  attachmentId: string         // provider-native id, fetch bytes separately
  filename:     string
  mimeType:     string
  sizeBytes:    number
  contentId:    string | null  // for cid: refs in HTML
  inline:       boolean
}

type MailMessage = {
  messageId:    MessageId
  threadId:     ThreadId | null
  accountId:    AccountId
  provider:     "gmail" | "outlook"
  from:         EmailAddress
  to, cc, bcc, replyTo: ReadonlyArray<EmailAddress>
  subject:      string
  bodyText:     string         // both can be present; both default to ""
  bodyHtml:     string
  headers:      Record<string, ReadonlyArray<string>>   // lowercased keys, multi-value
  attachments:  ReadonlyArray<AttachmentRef>
  labels:       ReadonlyArray<string>                   // raw provider strings, NOT normalized
  receivedAt:   Date
  sentAt:       Date | null
  sizeEstimate: number
}

type AccountStatus = "active" | "paused" | "revoked"

type MailboxAccount = {
  accountId:       AccountId
  userId:          UserId
  provider:        "gmail" | "outlook"
  emailAddress:    string         // lowercased
  status:          AccountStatus
  credentials:     Record<string, unknown>   // opaque to core
  lastEventCursor: string | null
  watchExpiresAt:  Date | null
  createdAt, updatedAt: Date
}

type MailboxEvent = {
  eventId:         string
  providerPayload: unknown        // opaque to core; resolver decodes
  receivedAt:      Date
}

type TriggerJobState = "pending" | "succeeded" | "failed"
type TriggerJob = {
  jobId:           JobId
  messageId:       MessageId
  accountId:       AccountId
  state:           TriggerJobState
  attempts:        number
  lastError:       string | null
  nextAttemptAt:   Date | null    // null when state != "pending"
  claimedAt:       Date | null
  claimedBy:       string | null
  leaseExpiresAt:  Date | null
  createdAt:       Date
  completedAt:     Date | null
}
```

### Handler contract

```ts
type HandlerContext = { jobId: JobId; accountId: AccountId; attempt: number }

type MessageHandlerFn = (
  message: MailMessage,
  ctx:     HandlerContext,
) => Promise<Result<void, HandlerError>>

type HandlerError =
  | { _tag: "Transient";  message: string; cause?: unknown }
  | { _tag: "Permanent";  message: string; cause?: unknown }
```

`Transient` → retry per backoff. `Permanent` → dead-letter immediately. Uncaught throws are treated as `Transient` (kernel backstop).

### Store

See `store-contract.md`. Exports: `StoreAdapter` interface, the input/output types (`CreateAccountInput`, `AccountPatch`, `CommitMessagesInput`, `ClaimTriggerInput`, `ClaimedJob`).

### Worker config

```ts
type WorkerConfig = {
  workerId?:          string                 // defaults to host-pid-rand
  triggerConcurrency?: number                // default 8
  claimBatchSize?:    number                 // default 16; must be >= triggerConcurrency
  leaseDurationMs?:   number                 // default 5 min
  idlePollIntervalMs?: number                // default 1s
  maxAttempts?:       number                 // default 10
  backoff?:           Partial<BackoffConfig>
  clock?:             () => Date             // for tests
  random?:            () => number           // for tests
}

resolveWorkerConfig(input?: WorkerConfig): ResolvedWorkerConfig   // exposes the merged result
```

### Pipeline + provider plugin shape (rarely-needed internals, but exported)

```ts
createPipeline(deps: PipelineDeps): MailboxPipeline   // for tests / custom providers

interface ProviderRuntime {
  resolver: MessageResolver
  start(): Promise<void>
  stop():  Promise<void>
  wait():  Promise<void>
}
interface ProviderFactory<API = unknown> {
  build(deps: ProviderBuildDeps): ProviderRuntime & { api: API }
}
type ProviderBuildDeps = { store: StoreAdapter; pipeline: MailboxPipeline; logger: StationLogger; clock: () => Date }
```

## `mailbox-station/effect` exports

Same kernel, Effect-typed skin:

```ts
import { createStationEffect, StationService, stationLayer } from "mailbox-station/effect"
```

Use only if the consumer is already on Effect-TS. The Promise + Result API is the default.

## `gmail-station` exports

```ts
gmailProvider(input: GmailConfig): ProviderFactory<GmailProviderApi>

defaultGmailClientFactory     // production OAuth2 + @googleapis/gmail
decodeNotification            // Pub/Sub notification → { emailAddress, historyId }
parseGmailMessage             // Gmail Schema$Message → MailMessage (pure)
```

### `GmailConfig`

```ts
type GmailConfig = {
  googleClientId:     string                 // OAuth client
  googleClientSecret: string
  gcpProjectId:       string
  pubsubTopic:        string                 // fully-qualified projects/<id>/topics/<name>
  pubsubSubscription: string                 // fully-qualified pull subscription
  labelFilter?:       ReadonlyArray<string> | null   // default ["INBOX"]; null = all
  pullConcurrency?:   number                 // default 4
  fetchConcurrency?:  number                 // default 8 (messages.get)
  renewalWindowMs?:   number                 // default 24h
  pubsubAuth?:
    | { kind: "adc" }                                 // default
    | { kind: "keyFile";    keyFilename: string }
    | { kind: "credentials"; credentials: ServiceAccountKey }
  clientFactory?:       GmailClientFactory   // for tests
  subscriptionFactory?: SubscriptionFactory  // for tests
}
```

### `GmailProviderApi` (what `station.providers.gmail` exposes)

```ts
register(input: { userId: UserIdType; emailAddress: string; refreshToken: string })
  : Promise<Result<{ accountId: AccountId }, RegisterError>>

renewExpiringWatches(): Promise<Result<RenewSummary, never>>
```

`RegisterError` tags: `DuplicateAccount` | `InvalidGrant` | `ProviderTransient` | `ProviderPermanent` | `StoreError`.

`RenewSummary`:
```ts
{
  renewed: number
  failed:  number
  revoked: number   // accounts whose refresh token was rejected; status moved to "revoked"
  details: Array<{ accountId; emailAddress; outcome: "renewed"|"failed"|"revoked"; error? }>
}
```

## `mailbox-station-conformance` exports

```ts
runStoreConformance(input: ConformanceInput): void

type ConformanceInput = {
  name: string
  makeStore: () => Promise<{ store: StoreAdapter; teardown?: () => Promise<void> }>
}

createReferenceStore()      // in-memory reference; passes the suite by definition
type ReferenceStore = ...
synthMessage, aUserId, anAccountId, aMessageId      // fixtures
```

Invoke from a `*.test.ts` — it calls Vitest's `describe`/`it` internally.
