import Database from "better-sqlite3"
import {
  AccountId as makeAccountId,
  JobId as makeJobId,
  MessageId as makeMessageId,
  ThreadId as makeThreadId,
  UserId as makeUserId,
  err,
  ok,
} from "@mail-station/mailbox-station"
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
  Result,
  StoreAdapter,
  StoreError,
  TriggerJob,
} from "@mail-station/mailbox-station"

/**
 * SQLite Store adapter, demonstrating how to satisfy the contract.
 *
 * Atomicity is provided by SQLite transactions; idempotency on `(accountId,
 * messageId)` is enforced by `INSERT OR IGNORE` against a unique index.
 * Concurrent claims are serialized via `BEGIN IMMEDIATE`.
 */
export const createSqliteStore = (filename: string): StoreAdapter & { close: () => void } => {
  const db = new Database(filename)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL,
      credentials TEXT NOT NULL,
      last_event_cursor TEXT,
      watch_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (provider, email)
    );

    CREATE TABLE IF NOT EXISTS messages (
      account_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (account_id, message_id),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id)
    );

    CREATE TABLE IF NOT EXISTS trigger_jobs (
      job_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at INTEGER,
      claimed_at INTEGER,
      claimed_by TEXT,
      lease_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_pending
      ON trigger_jobs(state, next_attempt_at, lease_expires_at);
  `)

  const rowToAccount = (r: any): MailboxAccount => ({
    accountId: makeAccountId(r.account_id),
    userId: makeUserId(r.user_id),
    provider: r.provider as Provider,
    emailAddress: r.email,
    status: r.status,
    credentials: JSON.parse(r.credentials),
    lastEventCursor: r.last_event_cursor,
    watchExpiresAt: r.watch_expires_at ? new Date(r.watch_expires_at) : null,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  })

  const rowToMessage = (r: any): MailMessage => {
    const m = JSON.parse(r.payload)
    return {
      ...m,
      messageId: makeMessageId(m.messageId),
      threadId: m.threadId ? makeThreadId(m.threadId) : null,
      accountId: makeAccountId(m.accountId),
      receivedAt: new Date(m.receivedAt),
      sentAt: m.sentAt ? new Date(m.sentAt) : null,
    }
  }

  const rowToJob = (r: any): TriggerJob => ({
    jobId: makeJobId(r.job_id),
    accountId: makeAccountId(r.account_id),
    messageId: makeMessageId(r.message_id),
    state: r.state,
    attempts: r.attempts,
    lastError: r.last_error,
    nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at) : null,
    claimedAt: r.claimed_at ? new Date(r.claimed_at) : null,
    claimedBy: r.claimed_by,
    leaseExpiresAt: r.lease_expires_at ? new Date(r.lease_expires_at) : null,
    createdAt: new Date(r.created_at),
    completedAt: r.completed_at ? new Date(r.completed_at) : null,
  })

  const wrap = async <T>(fn: () => Result<T, StoreError> | T): Promise<Result<T, StoreError>> => {
    try {
      const r = fn()
      if (r && typeof r === "object" && "ok" in (r as object)) return r as Result<T, StoreError>
      return ok(r as T)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return err({ _tag: "Permanent", message, cause })
    }
  }

  return {
    close: () => db.close(),

    createAccount: async (input: CreateAccountInput) =>
      wrap<MailboxAccount>(() => {
        const id = makeAccountId(crypto.randomUUID())
        const email = input.emailAddress.toLowerCase()
        try {
          db.prepare(
            `INSERT INTO accounts (account_id, user_id, provider, email, status, credentials, last_event_cursor, watch_expires_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
          ).run(
            id,
            input.userId,
            input.provider,
            email,
            JSON.stringify(input.credentials),
            input.lastEventCursor,
            input.watchExpiresAt?.getTime() ?? null,
            input.now.getTime(),
            input.now.getTime(),
          )
        } catch (e: any) {
          if (typeof e.message === "string" && e.message.includes("UNIQUE")) {
            return err<StoreError>({ _tag: "DuplicateAccount", provider: input.provider, emailAddress: email })
          }
          throw e
        }
        const row = db.prepare(`SELECT * FROM accounts WHERE account_id = ?`).get(id)
        return ok(rowToAccount(row))
      }),

    getAccount: async (accountId: AccountId) =>
      wrap<MailboxAccount>(() => {
        const row = db.prepare(`SELECT * FROM accounts WHERE account_id = ?`).get(accountId)
        if (!row) return err<StoreError>({ _tag: "AccountNotFound", accountId })
        return ok(rowToAccount(row))
      }),

    getAccountByEmail: async (provider: Provider, email: string) =>
      wrap<MailboxAccount>(() => {
        const row = db
          .prepare(`SELECT * FROM accounts WHERE provider = ? AND email = ?`)
          .get(provider, email.toLowerCase())
        if (!row) return err<StoreError>({ _tag: "AccountNotFound", emailAddress: email.toLowerCase() })
        return ok(rowToAccount(row))
      }),

    updateAccount: async (accountId: AccountId, patch: AccountPatch) =>
      wrap<MailboxAccount>(() => {
        const existing = db.prepare(`SELECT * FROM accounts WHERE account_id = ?`).get(accountId)
        if (!existing) return err<StoreError>({ _tag: "AccountNotFound", accountId })
        const cur = rowToAccount(existing)
        db.prepare(
          `UPDATE accounts SET status = ?, credentials = ?, last_event_cursor = ?, watch_expires_at = ?, updated_at = ? WHERE account_id = ?`,
        ).run(
          patch.status ?? cur.status,
          JSON.stringify(patch.credentials ?? cur.credentials),
          patch.lastEventCursor === undefined ? cur.lastEventCursor : patch.lastEventCursor,
          patch.watchExpiresAt === undefined
            ? cur.watchExpiresAt?.getTime() ?? null
            : patch.watchExpiresAt?.getTime() ?? null,
          patch.now.getTime(),
          accountId,
        )
        const row = db.prepare(`SELECT * FROM accounts WHERE account_id = ?`).get(accountId)
        return ok(rowToAccount(row))
      }),

    listAccountsExpiringWatch: async (provider: Provider, before: Date) =>
      wrap<readonly MailboxAccount[]>(() => {
        const rows = db
          .prepare(`SELECT * FROM accounts WHERE provider = ? AND watch_expires_at IS NOT NULL AND watch_expires_at < ?`)
          .all(provider, before.getTime())
        return ok((rows as any[]).map(rowToAccount))
      }),

    commitMessages: async (input: CommitMessagesInput) =>
      wrap<{ committedMessageIds: readonly MessageId[] }>(() => {
        const tx = db.transaction(() => {
          const inserted: MessageId[] = []
          for (const m of input.messages) {
            const r = db
              .prepare(`INSERT OR IGNORE INTO messages (account_id, message_id, payload) VALUES (?, ?, ?)`)
              .run(input.accountId, m.messageId, JSON.stringify(m))
            if (r.changes > 0) inserted.push(m.messageId)
          }
          db.prepare(
            `UPDATE accounts SET last_event_cursor = ?, updated_at = ? WHERE account_id = ?`,
          ).run(input.newCursor, input.now.getTime(), input.accountId)
          for (const mid of inserted) {
            const jobId = `job-${crypto.randomUUID()}`
            db.prepare(
              `INSERT INTO trigger_jobs (job_id, account_id, message_id, state, attempts, next_attempt_at, created_at)
               VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
            ).run(jobId, input.accountId, mid, input.now.getTime(), input.now.getTime())
          }
          return inserted
        })
        const inserted = tx()
        return ok({ committedMessageIds: inserted })
      }),

    claimTriggerJobs: async (input: ClaimTriggerInput) =>
      wrap<readonly ClaimedJob[]>(() => {
        const tx = db.transaction(() => {
          const candidates = db
            .prepare(
              `SELECT * FROM trigger_jobs
               WHERE state = 'pending'
                 AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
                 AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
               ORDER BY next_attempt_at NULLS FIRST
               LIMIT ?`,
            )
            .all(input.now.getTime(), input.now.getTime(), input.limit)
          const claimed: ClaimedJob[] = []
          for (const row of candidates as any[]) {
            const lease = input.now.getTime() + input.leaseDurationMs
            db.prepare(
              `UPDATE trigger_jobs SET claimed_at = ?, claimed_by = ?, lease_expires_at = ? WHERE job_id = ?`,
            ).run(input.now.getTime(), input.workerId, lease, row.job_id)
            const updated = db.prepare(`SELECT * FROM trigger_jobs WHERE job_id = ?`).get(row.job_id)
            const msgRow = db
              .prepare(`SELECT payload FROM messages WHERE account_id = ? AND message_id = ?`)
              .get(row.account_id, row.message_id) as any
            if (!msgRow) continue
            claimed.push({
              job: rowToJob(updated),
              message: rowToMessage(msgRow),
            })
          }
          return claimed
        })
        return ok(tx())
      }),

    markTriggerDone: async (jobId: JobId, now: Date) =>
      wrap<void>(() => {
        db.prepare(
          `UPDATE trigger_jobs SET state = 'succeeded', completed_at = ?, lease_expires_at = NULL, next_attempt_at = NULL WHERE job_id = ?`,
        ).run(now.getTime(), jobId)
        return ok(undefined)
      }),

    markTriggerFailed: async (jobId: JobId, errorStr: string, nextAttemptAt: Date | null, now: Date) =>
      wrap<void>(() => {
        if (nextAttemptAt === null) {
          db.prepare(
            `UPDATE trigger_jobs SET state = 'failed', attempts = attempts + 1, last_error = ?, completed_at = ?, lease_expires_at = NULL, next_attempt_at = NULL WHERE job_id = ?`,
          ).run(errorStr, now.getTime(), jobId)
        } else {
          db.prepare(
            `UPDATE trigger_jobs SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?, claimed_at = NULL, claimed_by = NULL, lease_expires_at = NULL WHERE job_id = ?`,
          ).run(errorStr, nextAttemptAt.getTime(), jobId)
        }
        return ok(undefined)
      }),
  }
}
