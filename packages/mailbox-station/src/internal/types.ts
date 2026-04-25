import type { AccountId, JobId, MessageId, ThreadId, UserId } from "./ids.js"

export type Provider = "gmail" | "outlook"

export type EmailAddress = { readonly name: string | null; readonly email: string }

export type AttachmentRef = {
  readonly attachmentId: string
  readonly filename: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly contentId: string | null
  readonly inline: boolean
}

export type MailMessage = {
  readonly messageId: MessageId
  readonly threadId: ThreadId | null
  readonly accountId: AccountId
  readonly provider: Provider

  readonly from: EmailAddress
  readonly to: ReadonlyArray<EmailAddress>
  readonly cc: ReadonlyArray<EmailAddress>
  readonly bcc: ReadonlyArray<EmailAddress>
  readonly replyTo: ReadonlyArray<EmailAddress>
  readonly subject: string

  readonly bodyText: string
  readonly bodyHtml: string

  readonly headers: Record<string, ReadonlyArray<string>>
  readonly attachments: ReadonlyArray<AttachmentRef>
  readonly labels: ReadonlyArray<string>

  readonly receivedAt: Date
  readonly sentAt: Date | null
  readonly sizeEstimate: number
}

export type AccountStatus = "active" | "paused" | "revoked"

export type MailboxAccount = {
  readonly accountId: AccountId
  readonly userId: UserId
  readonly provider: Provider
  readonly emailAddress: string
  readonly status: AccountStatus
  readonly credentials: Record<string, unknown>
  readonly lastEventCursor: string | null
  readonly watchExpiresAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type MailboxEvent = {
  readonly eventId: string
  readonly providerPayload: unknown
  readonly receivedAt: Date
}

export type TriggerJobState = "pending" | "succeeded" | "failed"

export type TriggerJob = {
  readonly jobId: JobId
  readonly messageId: MessageId
  readonly accountId: AccountId
  readonly state: TriggerJobState
  readonly attempts: number
  readonly lastError: string | null
  readonly nextAttemptAt: Date | null
  readonly claimedAt: Date | null
  readonly claimedBy: string | null
  readonly leaseExpiresAt: Date | null
  readonly createdAt: Date
  readonly completedAt: Date | null
}

// ---------- Store I/O ----------

export type CreateAccountInput = {
  readonly userId: UserId
  readonly provider: Provider
  readonly emailAddress: string
  readonly credentials: Record<string, unknown>
  readonly lastEventCursor: string | null
  readonly watchExpiresAt: Date | null
  readonly now: Date
}

export type AccountPatch = {
  readonly status?: AccountStatus
  readonly credentials?: Record<string, unknown>
  readonly lastEventCursor?: string | null
  readonly watchExpiresAt?: Date | null
  readonly now: Date
}

export type CommitMessagesInput = {
  readonly accountId: AccountId
  readonly messages: ReadonlyArray<MailMessage>
  readonly newCursor: string
  readonly now: Date
}

export type ClaimTriggerInput = {
  readonly workerId: string
  readonly limit: number
  readonly leaseDurationMs: number
  readonly now: Date
}

export type ClaimedJob = {
  readonly job: TriggerJob
  readonly message: MailMessage
}

// ---------- Errors ----------

export type StoreError =
  | { readonly _tag: "Transient"; readonly message: string; readonly cause?: unknown }
  | { readonly _tag: "Permanent"; readonly message: string; readonly cause?: unknown }
  | { readonly _tag: "AccountNotFound"; readonly accountId?: AccountId; readonly emailAddress?: string }
  | { readonly _tag: "DuplicateAccount"; readonly provider: Provider; readonly emailAddress: string }

export type ResolverError =
  | { readonly _tag: "MalformedNotification"; readonly details: string }
  | { readonly _tag: "AccountNotFound"; readonly emailAddress: string }
  | { readonly _tag: "AccountPaused"; readonly accountId: AccountId }
  | { readonly _tag: "AccountRevoked"; readonly accountId: AccountId }
  | { readonly _tag: "CredentialsRevoked"; readonly accountId: AccountId; readonly reason: string }
  | { readonly _tag: "ProviderTransient"; readonly message: string; readonly statusCode?: number; readonly cause?: unknown }
  | { readonly _tag: "ProviderPermanent"; readonly message: string; readonly statusCode?: number; readonly cause?: unknown }

export type IngressError =
  | { readonly _tag: "DecodeError"; readonly message: string }
  | { readonly _tag: "SubscriptionError"; readonly message: string; readonly cause?: unknown }

export type HandlerError =
  | { readonly _tag: "Transient"; readonly message: string; readonly cause?: unknown }
  | { readonly _tag: "Permanent"; readonly message: string; readonly cause?: unknown }

// ---------- Pipeline / Resolver / Handler contracts ----------

export type ResolveResult = {
  readonly accountId: AccountId
  readonly messages: ReadonlyArray<MailMessage>
  readonly newCursor: string
}

export interface MessageResolver {
  resolve(event: MailboxEvent): Promise<import("./result.js").Result<ResolveResult, ResolverError>>
}

export type HandlerContext = {
  readonly jobId: JobId
  readonly accountId: AccountId
  readonly attempt: number
}

export type MessageHandlerFn = (
  message: MailMessage,
  ctx: HandlerContext,
) => Promise<import("./result.js").Result<void, HandlerError>>

export interface MailboxPipeline {
  processEvent(event: MailboxEvent): Promise<"ack" | "nack">
}

// ---------- Logger ----------

export interface StationLogger {
  debug(event: string, fields?: Record<string, unknown>): void
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

// ---------- Store interface ----------

export interface StoreAdapter {
  createAccount(input: CreateAccountInput): Promise<import("./result.js").Result<MailboxAccount, StoreError>>
  getAccount(accountId: AccountId): Promise<import("./result.js").Result<MailboxAccount, StoreError>>
  getAccountByEmail(provider: Provider, email: string): Promise<import("./result.js").Result<MailboxAccount, StoreError>>
  updateAccount(accountId: AccountId, patch: AccountPatch): Promise<import("./result.js").Result<MailboxAccount, StoreError>>
  listAccountsExpiringWatch(provider: Provider, before: Date): Promise<import("./result.js").Result<ReadonlyArray<MailboxAccount>, StoreError>>

  commitMessages(input: CommitMessagesInput): Promise<import("./result.js").Result<{ readonly committedMessageIds: ReadonlyArray<MessageId> }, StoreError>>

  claimTriggerJobs(input: ClaimTriggerInput): Promise<import("./result.js").Result<ReadonlyArray<ClaimedJob>, StoreError>>
  markTriggerDone(jobId: JobId, now: Date): Promise<import("./result.js").Result<void, StoreError>>
  markTriggerFailed(
    jobId: JobId,
    error: string,
    nextAttemptAt: Date | null,
    now: Date,
  ): Promise<import("./result.js").Result<void, StoreError>>
}

// ---------- Worker config ----------

export type BackoffConfig = {
  readonly baseMs: number
  readonly factor: number
  readonly maxMs: number
  readonly jitterFactor: number
}

export type WorkerConfig = {
  readonly workerId?: string
  readonly triggerConcurrency?: number
  readonly claimBatchSize?: number
  readonly leaseDurationMs?: number
  readonly idlePollIntervalMs?: number
  readonly maxAttempts?: number
  readonly backoff?: Partial<BackoffConfig>
  readonly clock?: () => Date
  readonly random?: () => number
}

export type ResolvedWorkerConfig = {
  readonly workerId: string
  readonly triggerConcurrency: number
  readonly claimBatchSize: number
  readonly leaseDurationMs: number
  readonly idlePollIntervalMs: number
  readonly maxAttempts: number
  readonly backoff: BackoffConfig
  readonly clock: () => Date
  readonly random: () => number
}

// ---------- Provider plugin shape ----------

export interface ProviderRuntime {
  readonly resolver: MessageResolver
  start(): Promise<void>
  stop(): Promise<void>
  wait(): Promise<void>
}

export interface ProviderFactory<API = unknown> {
  /** internal: wire-up called by createStation */
  build(deps: ProviderBuildDeps): ProviderRuntime & { api: API }
}

export type ProviderBuildDeps = {
  readonly store: StoreAdapter
  readonly pipeline: MailboxPipeline
  readonly logger: StationLogger
  readonly clock: () => Date
}
