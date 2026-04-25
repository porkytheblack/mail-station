import type { gmail_v1 } from "@googleapis/gmail"
import type { Subscription } from "@google-cloud/pubsub"
import type {
  AccountId,
  IngressError,
  MailMessage,
  MessageId,
  ResolverError,
  Result,
  StoreAdapter,
  UserIdType,
} from "mailbox-station"

export type ServiceAccountKey = {
  readonly client_email: string
  readonly private_key: string
  readonly project_id?: string
  readonly [k: string]: unknown
}

export type GmailConfig = {
  readonly googleClientId: string
  readonly googleClientSecret: string
  readonly gcpProjectId: string
  readonly pubsubTopic: string
  readonly pubsubSubscription: string
  readonly labelFilter?: ReadonlyArray<string> | null
  readonly pullConcurrency?: number
  readonly renewalWindowMs?: number
  readonly fetchConcurrency?: number
  readonly pubsubAuth?:
    | { readonly kind: "adc" }
    | { readonly kind: "keyFile"; readonly keyFilename: string }
    | { readonly kind: "credentials"; readonly credentials: ServiceAccountKey }
  /** Inject a fake transport for tests. */
  readonly clientFactory?: GmailClientFactory
  readonly subscriptionFactory?: SubscriptionFactory
}

export type ResolvedGmailConfig = Required<Omit<GmailConfig, "clientFactory" | "subscriptionFactory" | "pubsubAuth" | "labelFilter">> & {
  readonly labelFilter: ReadonlyArray<string> | null
  readonly pubsubAuth: NonNullable<GmailConfig["pubsubAuth"]>
  readonly clientFactory?: GmailClientFactory
  readonly subscriptionFactory?: SubscriptionFactory
}

export type GmailCredentials = {
  readonly refreshToken: string
  readonly accessToken?: string
  readonly accessTokenExpiresAt?: Date
}

/**
 * Per-account API surface used by the resolver and watch manager. Wraps the
 * Gmail SDK plus OAuth2 refresh + retry. Returned via `Result` so callers
 * never have to try/catch around Gmail SDK quirks.
 */
export type GmailClient = {
  /**
   * Validate the refresh token via a token-endpoint round trip. Used by
   * `register` to fast-fail on `invalid_grant` before calling `users.watch`,
   * so we don't leak a watch when the credentials are dead on arrival.
   */
  validateRefreshToken(): Promise<Result<void, ResolverError>>
  watch(input: {
    topicName: string
    labelIds?: ReadonlyArray<string>
  }): Promise<Result<{ historyId: string; expiration: Date }, ResolverError>>
  stop(): Promise<Result<void, ResolverError>>
  historyList(input: {
    startHistoryId: string
    labelId?: string
    pageToken?: string
  }): Promise<Result<gmail_v1.Schema$ListHistoryResponse, ResolverError | { _tag: "HistoryGone" }>>
  messageGet(messageId: string): Promise<Result<gmail_v1.Schema$Message, ResolverError | { _tag: "MessageGone" }>>
}

export type GmailClientFactory = (
  credentials: GmailCredentials,
  options: { config: ResolvedGmailConfig; onTokenRefresh: (creds: GmailCredentials) => void },
) => GmailClient

export type SubscriptionFactory = (config: ResolvedGmailConfig) => SubscriptionLike

export type SubscriptionMessage = {
  readonly id: string
  readonly data: Buffer
  readonly publishTime: Date | null
  ack(): void
  nack(): void
}

export interface SubscriptionLike {
  on(event: "message", listener: (msg: SubscriptionMessage) => void): this
  on(event: "error", listener: (err: Error) => void): this
  on(event: "close", listener: () => void): this
  removeAllListeners(): void
  close(): Promise<void>
  /** Optional: assert pull-type subscription. */
  metadata?(): Promise<{ pushConfigPresent: boolean }>
}

export type Notification = {
  readonly emailAddress: string
  readonly historyId: string
}

export type GmailProviderApi = {
  register(input: {
    userId: UserIdType
    emailAddress: string
    refreshToken: string
  }): Promise<Result<{ accountId: AccountId }, RegisterError>>
  renewExpiringWatches(): Promise<Result<RenewSummary, never>>
}

export type RegisterError =
  | { _tag: "DuplicateAccount"; emailAddress: string }
  | { _tag: "InvalidGrant"; reason: string }
  | { _tag: "ProviderTransient"; message: string; cause?: unknown }
  | { _tag: "ProviderPermanent"; message: string; cause?: unknown }
  | { _tag: "StoreError"; message: string }

export type RenewSummary = {
  readonly renewed: number
  readonly failed: number
  readonly revoked: number
  readonly details: ReadonlyArray<{
    accountId: AccountId
    emailAddress: string
    outcome: "renewed" | "failed" | "revoked"
    error?: string
  }>
}

export type GmailRuntimeDeps = {
  readonly store: StoreAdapter
  readonly pipeline: import("mailbox-station").MailboxPipeline
  readonly logger: import("mailbox-station").StationLogger
  readonly clock: () => Date
  readonly config: ResolvedGmailConfig
}

export type { MailMessage, MessageId, IngressError, ResolverError }
