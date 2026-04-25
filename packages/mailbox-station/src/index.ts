// Public Promise + Result API for mailbox-station.

export {
  AccountId,
  JobId,
  MessageId,
  ThreadId,
  UserId,
  newAccountId,
} from "./internal/ids.js"

export type {
  AccountId as AccountIdType,
  JobId as JobIdType,
  MessageId as MessageIdType,
  ThreadId as ThreadIdType,
  UserId as UserIdType,
} from "./internal/ids.js"

export { ok, err, isOk, isErr, map, mapErr } from "./internal/result.js"
export type { Result } from "./internal/result.js"

export { defaultBackoff, computeNextAttemptAt, nextAttemptDelayMs } from "./internal/backoff.js"

export { consoleLogger, noopLogger } from "./internal/logger.js"

export { createStation } from "./internal/station.js"
export type { Station, StationInput, ProviderApis } from "./internal/station.js"

export { createPipeline } from "./internal/pipeline.js"
export type { PipelineDeps } from "./internal/pipeline.js"

export { resolveWorkerConfig } from "./internal/config.js"

export type {
  Provider,
  EmailAddress,
  AttachmentRef,
  MailMessage,
  AccountStatus,
  MailboxAccount,
  MailboxEvent,
  TriggerJob,
  TriggerJobState,
  CreateAccountInput,
  AccountPatch,
  CommitMessagesInput,
  ClaimTriggerInput,
  ClaimedJob,
  StoreError,
  ResolverError,
  IngressError,
  HandlerError,
  ResolveResult,
  MessageResolver,
  MessageHandlerFn,
  HandlerContext,
  MailboxPipeline,
  StationLogger,
  StoreAdapter,
  WorkerConfig,
  ResolvedWorkerConfig,
  BackoffConfig,
  ProviderRuntime,
  ProviderFactory,
  ProviderBuildDeps,
} from "./internal/types.js"
