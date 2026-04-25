// Skeleton Postgres StoreAdapter for mailbox-station.
// Brings in `pg` for the connection pool — adapt to your existing driver if you
// already have one. Critical invariants are commented inline; verify by running
// the conformance battery (`mailbox-station-conformance`).
//
// Schema (run before using):
//   CREATE TABLE accounts (
//     account_id        UUID PRIMARY KEY,
//     user_id           TEXT NOT NULL,
//     provider          TEXT NOT NULL,
//     email             TEXT NOT NULL,
//     status            TEXT NOT NULL CHECK (status IN ('active','paused','revoked')),
//     credentials       JSONB NOT NULL,
//     last_event_cursor TEXT,
//     watch_expires_at  TIMESTAMPTZ,
//     created_at        TIMESTAMPTZ NOT NULL,
//     updated_at        TIMESTAMPTZ NOT NULL,
//     UNIQUE (provider, email)
//   );
//
//   CREATE TABLE messages (
//     account_id  UUID NOT NULL REFERENCES accounts(account_id),
//     message_id  TEXT NOT NULL,
//     payload     JSONB NOT NULL,
//     PRIMARY KEY (account_id, message_id)
//   );
//
//   CREATE TABLE trigger_jobs (
//     job_id            UUID PRIMARY KEY,
//     account_id        UUID NOT NULL,
//     message_id        TEXT NOT NULL,
//     state             TEXT NOT NULL CHECK (state IN ('pending','succeeded','failed')),
//     attempts          INT  NOT NULL DEFAULT 0,
//     last_error        TEXT,
//     next_attempt_at   TIMESTAMPTZ,
//     claimed_at        TIMESTAMPTZ,
//     claimed_by        TEXT,
//     lease_expires_at  TIMESTAMPTZ,
//     created_at        TIMESTAMPTZ NOT NULL,
//     completed_at      TIMESTAMPTZ,
//     FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, message_id)
//   );
//   CREATE INDEX idx_jobs_pending ON trigger_jobs (state, next_attempt_at, lease_expires_at);

import { Pool, type PoolClient } from "pg"
import {
  AccountId as makeAccountId,
  JobId as makeJobId,
  MessageId as makeMessageId,
  ThreadId as makeThreadId,
  UserId as makeUserId,
  err,
  ok,
} from "mailbox-station"
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
} from "mailbox-station"

export const createPostgresStore = (pool: Pool): StoreAdapter => {
  // -- helpers -----------------------------------------------------------------

  const wrap = async <T>(fn: () => Promise<Result<T, StoreError>>): Promise<Result<T, StoreError>> => {
    try {
      return await fn()
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause)
      // Promote known-retryable errors to Transient (deadlocks, lock timeouts, conn resets).
      // Default to Permanent so structural bugs surface instead of looping silently.
      if (isRetryablePgError(cause)) return err({ _tag: "Transient", message, cause })
      return err({ _tag: "Permanent", message, cause })
    }
  }

  const rowToAccount = (r: any): MailboxAccount => ({
    accountId:       makeAccountId(r.account_id),
    userId:          makeUserId(r.user_id),
    provider:        r.provider as Provider,
    emailAddress:    r.email,
    status:          r.status,
    credentials:     r.credentials,
    lastEventCursor: r.last_event_cursor,
    watchExpiresAt:  r.watch_expires_at,
    createdAt:       r.created_at,
    updatedAt:       r.updated_at,
  })

  const rowToMessage = (m: any): MailMessage => ({
    ...m,
    messageId:  makeMessageId(m.messageId),
    threadId:   m.threadId ? makeThreadId(m.threadId) : null,
    accountId:  makeAccountId(m.accountId),
    receivedAt: new Date(m.receivedAt),
    sentAt:     m.sentAt ? new Date(m.sentAt) : null,
  })

  const rowToJob = (r: any): TriggerJob => ({
    jobId:           makeJobId(r.job_id),
    accountId:       makeAccountId(r.account_id),
    messageId:       makeMessageId(r.message_id),
    state:           r.state,
    attempts:        r.attempts,
    lastError:       r.last_error,
    nextAttemptAt:   r.next_attempt_at,
    claimedAt:       r.claimed_at,
    claimedBy:       r.claimed_by,
    leaseExpiresAt:  r.lease_expires_at,
    createdAt:       r.created_at,
    completedAt:     r.completed_at,
  })

  const tx = async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect()
    try {
      await c.query("BEGIN")
      const out = await fn(c)
      await c.query("COMMIT")
      return out
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {})
      throw e
    } finally {
      c.release()
    }
  }

  // -- adapter -----------------------------------------------------------------

  return {
    createAccount: (input: CreateAccountInput) =>
      wrap(async () => {
        const id = makeAccountId(crypto.randomUUID())
        const email = input.emailAddress.toLowerCase()
        try {
          await pool.query(
            `INSERT INTO accounts (account_id, user_id, provider, email, status, credentials,
                                   last_event_cursor, watch_expires_at, created_at, updated_at)
             VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$8)`,
            [id, input.userId, input.provider, email, input.credentials,
             input.lastEventCursor, input.watchExpiresAt, input.now],
          )
        } catch (e: any) {
          if (e?.code === "23505") {
            return err<StoreError>({ _tag: "DuplicateAccount", provider: input.provider, emailAddress: email })
          }
          throw e
        }
        const r = await pool.query(`SELECT * FROM accounts WHERE account_id=$1`, [id])
        return ok(rowToAccount(r.rows[0]))
      }),

    getAccount: (accountId: AccountId) =>
      wrap(async () => {
        const r = await pool.query(`SELECT * FROM accounts WHERE account_id=$1`, [accountId])
        if (r.rowCount === 0) return err<StoreError>({ _tag: "AccountNotFound", accountId })
        return ok(rowToAccount(r.rows[0]))
      }),

    getAccountByEmail: (provider, email) =>
      wrap(async () => {
        const r = await pool.query(
          `SELECT * FROM accounts WHERE provider=$1 AND email=$2`,
          [provider, email.toLowerCase()],
        )
        if (r.rowCount === 0) return err<StoreError>({ _tag: "AccountNotFound", emailAddress: email.toLowerCase() })
        return ok(rowToAccount(r.rows[0]))
      }),

    updateAccount: (accountId, patch: AccountPatch) =>
      wrap(async () => {
        // Read-modify-write so partial patches preserve unchanged columns.
        const cur = await pool.query(`SELECT * FROM accounts WHERE account_id=$1`, [accountId])
        if (cur.rowCount === 0) return err<StoreError>({ _tag: "AccountNotFound", accountId })
        const a = rowToAccount(cur.rows[0])
        await pool.query(
          `UPDATE accounts SET status=$2, credentials=$3, last_event_cursor=$4,
                               watch_expires_at=$5, updated_at=$6
           WHERE account_id=$1`,
          [
            accountId,
            patch.status ?? a.status,
            patch.credentials ?? a.credentials,
            patch.lastEventCursor === undefined ? a.lastEventCursor : patch.lastEventCursor,
            patch.watchExpiresAt === undefined ? a.watchExpiresAt   : patch.watchExpiresAt,
            patch.now,
          ],
        )
        const r = await pool.query(`SELECT * FROM accounts WHERE account_id=$1`, [accountId])
        return ok(rowToAccount(r.rows[0]))
      }),

    listAccountsExpiringWatch: (provider, before) =>
      wrap(async () => {
        const r = await pool.query(
          `SELECT * FROM accounts
           WHERE provider=$1 AND watch_expires_at IS NOT NULL AND watch_expires_at < $2`,
          [provider, before],
        )
        return ok(r.rows.map(rowToAccount))
      }),

    // ---- THE atomic-commit method ----
    //
    // Inserts messages (idempotent on (accountId, messageId)),
    // advances cursor, enqueues trigger jobs for inserted rows. All in one tx.
    commitMessages: (input: CommitMessagesInput) =>
      wrap(() =>
        tx(async (c) => {
          const inserted: MessageId[] = []
          for (const m of input.messages) {
            const r = await c.query(
              `INSERT INTO messages (account_id, message_id, payload)
               VALUES ($1,$2,$3)
               ON CONFLICT (account_id, message_id) DO NOTHING`,
              [input.accountId, m.messageId, m],
            )
            if (r.rowCount && r.rowCount > 0) inserted.push(m.messageId)
          }
          await c.query(
            `UPDATE accounts SET last_event_cursor=$2, updated_at=$3 WHERE account_id=$1`,
            [input.accountId, input.newCursor, input.now],
          )
          for (const messageId of inserted) {
            await c.query(
              `INSERT INTO trigger_jobs (job_id, account_id, message_id, state, attempts,
                                         next_attempt_at, created_at)
               VALUES ($1,$2,$3,'pending',0,$4,$5)`,
              [crypto.randomUUID(), input.accountId, messageId, input.now, input.now],
            )
          }
          return ok({ committedMessageIds: inserted })
        }),
      ),

    // ---- Lease-based claim ----
    //
    // SELECT FOR UPDATE SKIP LOCKED gives at-most-one-in-flight per row across
    // every worker process. Don't relax this — at-least-once handler invocation
    // depends on it.
    claimTriggerJobs: (input: ClaimTriggerInput) =>
      wrap(() =>
        tx(async (c) => {
          const candidates = await c.query(
            `SELECT * FROM trigger_jobs
             WHERE state='pending'
               AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
               AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
             ORDER BY next_attempt_at NULLS FIRST
             FOR UPDATE SKIP LOCKED
             LIMIT $2`,
            [input.now, input.limit],
          )
          const claimed: ClaimedJob[] = []
          for (const row of candidates.rows) {
            const lease = new Date(input.now.getTime() + input.leaseDurationMs)
            await c.query(
              `UPDATE trigger_jobs SET claimed_at=$2, claimed_by=$3, lease_expires_at=$4
               WHERE job_id=$1`,
              [row.job_id, input.now, input.workerId, lease],
            )
            const updated = await c.query(`SELECT * FROM trigger_jobs WHERE job_id=$1`, [row.job_id])
            const msg = await c.query(
              `SELECT payload FROM messages WHERE account_id=$1 AND message_id=$2`,
              [row.account_id, row.message_id],
            )
            if (msg.rowCount === 0) continue
            claimed.push({
              job:     rowToJob(updated.rows[0]),
              message: rowToMessage(msg.rows[0].payload),
            })
          }
          return ok(claimed)
        }),
      ),

    markTriggerDone: (jobId: JobId, now: Date) =>
      wrap(async () => {
        await pool.query(
          `UPDATE trigger_jobs
           SET state='succeeded', completed_at=$2, lease_expires_at=NULL, next_attempt_at=NULL
           WHERE job_id=$1`,
          [jobId, now],
        )
        return ok(undefined)
      }),

    markTriggerFailed: (jobId: JobId, errorStr: string, nextAttemptAt: Date | null, now: Date) =>
      wrap(async () => {
        if (nextAttemptAt === null) {
          // terminal: dead-letter
          await pool.query(
            `UPDATE trigger_jobs
             SET state='failed', attempts=attempts+1, last_error=$2,
                 completed_at=$3, lease_expires_at=NULL, next_attempt_at=NULL
             WHERE job_id=$1`,
            [jobId, errorStr, now],
          )
        } else {
          // retry: keep pending, clear lease so it's re-claimable
          await pool.query(
            `UPDATE trigger_jobs
             SET attempts=attempts+1, last_error=$2, next_attempt_at=$3,
                 claimed_at=NULL, claimed_by=NULL, lease_expires_at=NULL
             WHERE job_id=$1`,
            [jobId, errorStr, nextAttemptAt],
          )
        }
        return ok(undefined)
      }),
  }
}

// Postgres SQLSTATE codes worth retrying.
// 40001 = serialization_failure, 40P01 = deadlock_detected, 55P03 = lock_not_available,
// 53300 = too_many_connections, 08006 = connection_failure
const RETRYABLE_PG = new Set(["40001", "40P01", "55P03", "53300", "08006"])
const isRetryablePgError = (e: unknown): boolean => {
  const code = (e as { code?: unknown })?.code
  return typeof code === "string" && RETRYABLE_PG.has(code)
}
