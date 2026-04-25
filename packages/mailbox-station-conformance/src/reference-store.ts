import type {
  AccountId,
  AccountPatch,
  ClaimTriggerInput,
  ClaimedJob,
  CommitMessagesInput,
  CreateAccountInput,
  JobId,
  MailMessage,
  MailboxAccount,
  MessageId,
  Provider,
  StoreAdapter,
  StoreError,
  TriggerJob,
} from "@mail-station/mailbox-station"
import { err, ok, AccountId as makeAccountId, JobId as makeJobId } from "@mail-station/mailbox-station"
import type { Result } from "@mail-station/mailbox-station"

/**
 * Reference in-memory implementation of StoreAdapter. Used to:
 *   1. meta-test the conformance suite itself
 *   2. drive integration tests in core and provider packages
 *   3. serve as a worked reference for adapter authors
 *
 * Single Node event-loop: synchronous mutations between awaits are atomic,
 * which gives commitMessages and claimTriggerJobs their mutex semantics for
 * free. Real adapters need explicit locking.
 */
export type ReferenceStore = StoreAdapter & {
  // Test-only inspection helpers.
  _accounts(): ReadonlyArray<MailboxAccount>
  _messages(): ReadonlyArray<MailMessage>
  _jobs(): ReadonlyArray<TriggerJob>
}

type AccountRow = MailboxAccount
type MessageRow = MailMessage & { readonly _key: string }
type JobRow = TriggerJob

const accountKey = (provider: Provider, email: string) => `${provider}::${email.toLowerCase()}`
const messageKey = (accountId: AccountId, messageId: MessageId) => `${accountId}::${messageId}`

export const createReferenceStore = (): ReferenceStore => {
  const accountsById = new Map<AccountId, AccountRow>()
  const accountsByEmail = new Map<string, AccountId>()
  const messagesByKey = new Map<string, MessageRow>()
  const jobsById = new Map<JobId, JobRow>()

  let jobCounter = 0
  const newJobId = (): JobId => makeJobId(`job-${++jobCounter}`)

  const createAccount = async (
    input: CreateAccountInput,
  ): Promise<Result<MailboxAccount, StoreError>> => {
    const email = input.emailAddress.toLowerCase()
    const k = accountKey(input.provider, email)
    if (accountsByEmail.has(k)) {
      return err({ _tag: "DuplicateAccount", provider: input.provider, emailAddress: email })
    }
    const id = makeAccountId(crypto.randomUUID())
    const row: AccountRow = {
      accountId: id,
      userId: input.userId,
      provider: input.provider,
      emailAddress: email,
      status: "active",
      credentials: { ...input.credentials },
      lastEventCursor: input.lastEventCursor,
      watchExpiresAt: input.watchExpiresAt,
      createdAt: input.now,
      updatedAt: input.now,
    }
    accountsById.set(id, row)
    accountsByEmail.set(k, id)
    return ok(row)
  }

  const getAccount = async (
    accountId: AccountId,
  ): Promise<Result<MailboxAccount, StoreError>> => {
    const row = accountsById.get(accountId)
    if (!row) return err({ _tag: "AccountNotFound", accountId })
    return ok(row)
  }

  const getAccountByEmail = async (
    provider: Provider,
    email: string,
  ): Promise<Result<MailboxAccount, StoreError>> => {
    const id = accountsByEmail.get(accountKey(provider, email))
    if (!id) return err({ _tag: "AccountNotFound", emailAddress: email.toLowerCase() })
    const row = accountsById.get(id)
    if (!row) return err({ _tag: "AccountNotFound", emailAddress: email.toLowerCase() })
    return ok(row)
  }

  const updateAccount = async (
    accountId: AccountId,
    patch: AccountPatch,
  ): Promise<Result<MailboxAccount, StoreError>> => {
    const row = accountsById.get(accountId)
    if (!row) return err({ _tag: "AccountNotFound", accountId })
    const next: AccountRow = {
      ...row,
      status: patch.status ?? row.status,
      credentials: patch.credentials ? { ...patch.credentials } : row.credentials,
      lastEventCursor:
        patch.lastEventCursor === undefined ? row.lastEventCursor : patch.lastEventCursor,
      watchExpiresAt:
        patch.watchExpiresAt === undefined ? row.watchExpiresAt : patch.watchExpiresAt,
      updatedAt: patch.now,
    }
    accountsById.set(accountId, next)
    return ok(next)
  }

  const listAccountsExpiringWatch = async (
    provider: Provider,
    before: Date,
  ): Promise<Result<ReadonlyArray<MailboxAccount>, StoreError>> => {
    const rows: MailboxAccount[] = []
    for (const row of accountsById.values()) {
      if (row.provider !== provider) continue
      if (!row.watchExpiresAt) continue
      if (row.watchExpiresAt.getTime() < before.getTime()) rows.push(row)
    }
    return ok(rows)
  }

  const commitMessages = async (
    input: CommitMessagesInput,
  ): Promise<Result<{ committedMessageIds: ReadonlyArray<MessageId> }, StoreError>> => {
    const account = accountsById.get(input.accountId)
    if (!account) return err({ _tag: "AccountNotFound", accountId: input.accountId })

    // Stage everything; no synchronous failure modes after this point so
    // "all or nothing" trivially holds. Real adapters wrap in a transaction.
    const newlyInserted: MessageRow[] = []
    for (const m of input.messages) {
      const k = messageKey(input.accountId, m.messageId)
      if (messagesByKey.has(k)) continue
      const row: MessageRow = { ...m, _key: k }
      newlyInserted.push(row)
    }

    // Apply atomically.
    for (const row of newlyInserted) messagesByKey.set(row._key, row)
    accountsById.set(input.accountId, { ...account, lastEventCursor: input.newCursor, updatedAt: input.now })
    const committed: MessageId[] = []
    for (const row of newlyInserted) {
      const job: JobRow = {
        jobId: newJobId(),
        messageId: row.messageId,
        accountId: input.accountId,
        state: "pending",
        attempts: 0,
        lastError: null,
        nextAttemptAt: input.now,
        claimedAt: null,
        claimedBy: null,
        leaseExpiresAt: null,
        createdAt: input.now,
        completedAt: null,
      }
      jobsById.set(job.jobId, job)
      committed.push(row.messageId)
    }

    return ok({ committedMessageIds: committed })
  }

  const claimTriggerJobs = async (
    input: ClaimTriggerInput,
  ): Promise<Result<ReadonlyArray<ClaimedJob>, StoreError>> => {
    const claimed: ClaimedJob[] = []
    const nowMs = input.now.getTime()
    // Iterate in insertion order; stable across runs for determinism.
    for (const job of jobsById.values()) {
      if (claimed.length >= input.limit) break
      if (job.state !== "pending") continue
      if (job.nextAttemptAt && job.nextAttemptAt.getTime() > nowMs) continue
      // Lease check: claimable if no lease OR lease expired.
      if (job.leaseExpiresAt && job.leaseExpiresAt.getTime() > nowMs) continue

      const lease = new Date(nowMs + input.leaseDurationMs)
      const next: JobRow = {
        ...job,
        claimedAt: input.now,
        claimedBy: input.workerId,
        leaseExpiresAt: lease,
      }
      jobsById.set(job.jobId, next)

      const message = messagesByKey.get(messageKey(job.accountId, job.messageId))
      if (!message) {
        // Should never happen in a consistent Store, but skip if it does.
        continue
      }
      const { _key: _omit, ...m } = message
      claimed.push({ job: next, message: m as MailMessage })
    }
    return ok(claimed)
  }

  const markTriggerDone = async (jobId: JobId, now: Date): Promise<Result<void, StoreError>> => {
    const job = jobsById.get(jobId)
    if (!job) return err({ _tag: "Permanent", message: `unknown job ${jobId}` })
    jobsById.set(jobId, {
      ...job,
      state: "succeeded",
      completedAt: now,
      nextAttemptAt: null,
      leaseExpiresAt: null,
    })
    return ok(undefined)
  }

  const markTriggerFailed = async (
    jobId: JobId,
    errorStr: string,
    nextAttemptAt: Date | null,
    now: Date,
  ): Promise<Result<void, StoreError>> => {
    const job = jobsById.get(jobId)
    if (!job) return err({ _tag: "Permanent", message: `unknown job ${jobId}` })
    if (nextAttemptAt === null) {
      jobsById.set(jobId, {
        ...job,
        state: "failed",
        attempts: job.attempts + 1,
        lastError: errorStr,
        nextAttemptAt: null,
        leaseExpiresAt: null,
        completedAt: now,
      })
    } else {
      jobsById.set(jobId, {
        ...job,
        attempts: job.attempts + 1,
        lastError: errorStr,
        nextAttemptAt,
        leaseExpiresAt: null,
        claimedAt: null,
        claimedBy: null,
      })
    }
    return ok(undefined)
  }

  return {
    createAccount,
    getAccount,
    getAccountByEmail,
    updateAccount,
    listAccountsExpiringWatch,
    commitMessages,
    claimTriggerJobs,
    markTriggerDone,
    markTriggerFailed,
    _accounts: () => Array.from(accountsById.values()),
    _messages: () =>
      Array.from(messagesByKey.values()).map(({ _key: _, ...m }) => m as MailMessage),
    _jobs: () => Array.from(jobsById.values()),
  }
}
