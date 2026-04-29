# Store contract

The `StoreAdapter` is the single integration seam between `mailbox-station` and the user's persistence layer. Nine methods, all returning `Promise<Result<T, StoreError>>`. Adapter authors implement once for their backend (Postgres, SQLite, Redis, HTTP API, …).

## Method list

```ts
interface StoreAdapter {
  // ---- Account lifecycle ----
  createAccount(input: CreateAccountInput): Promise<Result<MailboxAccount, StoreError>>
  getAccount(accountId: AccountId): Promise<Result<MailboxAccount, StoreError>>
  getAccountByEmail(provider: Provider, email: string): Promise<Result<MailboxAccount, StoreError>>
  updateAccount(accountId: AccountId, patch: AccountPatch): Promise<Result<MailboxAccount, StoreError>>
  listAccountsExpiringWatch(provider: Provider, before: Date): Promise<Result<ReadonlyArray<MailboxAccount>, StoreError>>

  // ---- Atomic commit ----
  commitMessages(input: CommitMessagesInput): Promise<Result<{ committedMessageIds: ReadonlyArray<MessageId> }, StoreError>>

  // ---- Trigger jobs ----
  claimTriggerJobs(input: ClaimTriggerInput): Promise<Result<ReadonlyArray<ClaimedJob>, StoreError>>
  markTriggerDone(jobId: JobId, now: Date): Promise<Result<void, StoreError>>
  markTriggerFailed(jobId: JobId, error: string, nextAttemptAt: Date | null, now: Date): Promise<Result<void, StoreError>>
}
```

## Invariants the kernel relies on

These are not optional. The conformance battery (`mailbox-station-conformance`) tests each one — make the adapter pass it.

### 1. Account uniqueness on `(provider, emailAddress)`

`createAccount` must return `err({ _tag: "DuplicateAccount", provider, emailAddress })` if a row already exists for the same `(provider, emailAddress)` pair. Lowercase the email before comparing — `MailboxAccount.emailAddress` is canonically lowercased.

### 2. `commitMessages` is atomic across three writes

In a single transaction:
1. Insert each message in `input.messages` keyed by `(accountId, messageId)`. Use `INSERT … ON CONFLICT DO NOTHING` (or equivalent). Skip duplicates silently.
2. Update `accounts.lastEventCursor = input.newCursor` and `updatedAt = input.now`.
3. For each message that was actually inserted (not a duplicate), enqueue a row in `trigger_jobs` with `state='pending'`, `attempts=0`, `nextAttemptAt=input.now`.

Return only the `MessageId`s that were actually inserted (the deduped set). If any step fails, roll back all three; nothing is partially committed.

### 3. Idempotency on `(accountId, messageId)`

Calling `commitMessages` twice with the same payload must produce the same final state. The natural key is `(accountId, messageId)`. Enforce it with a unique index. The pipeline relies on this for at-least-once Pub/Sub redelivery.

### 4. Lease-based claim semantics in `claimTriggerJobs`

A job is claimable when:
```sql
state = 'pending'
AND (next_attempt_at IS NULL OR next_attempt_at <= :now)
AND (lease_expires_at IS NULL OR lease_expires_at <= :now)
```

When claiming, set `claimed_at=:now`, `claimed_by=:workerId`, `lease_expires_at=:now + :leaseDurationMs`. **Serialize concurrent claims** (Postgres: `SELECT … FOR UPDATE SKIP LOCKED`; SQLite: `BEGIN IMMEDIATE`). At-most-one in-flight per job across processes.

Return up to `input.limit` rows. The kernel calls in batches of `claimBatchSize` (default 16) and runs them at `triggerConcurrency` (default 8).

### 5. State transitions are explicit

`markTriggerDone(jobId, now)`:
```sql
UPDATE trigger_jobs
SET state='succeeded', completed_at=:now, lease_expires_at=NULL, next_attempt_at=NULL
WHERE job_id=:jobId
```

`markTriggerFailed(jobId, error, nextAttemptAt, now)`:
- If `nextAttemptAt === null` → terminal (dead-letter): `state='failed'`, `completed_at=:now`, increment `attempts`, set `last_error=:error`, clear lease + nextAttempt.
- If `nextAttemptAt !== null` → retry: keep `state='pending'`, increment `attempts`, set `last_error=:error`, set `next_attempt_at=:nextAttemptAt`, clear lease (`claimed_at=NULL, claimed_by=NULL, lease_expires_at=NULL`) so it's re-claimable.

The kernel computes `nextAttemptAt` itself via the configured backoff. Don't try to compute it in the adapter.

### 6. Errors are tagged, not exceptions

```ts
type StoreError =
  | { _tag: "Transient";       message: string; cause?: unknown }   // retry-able (network blip, lock)
  | { _tag: "Permanent";       message: string; cause?: unknown }   // structural (schema mismatch, etc.)
  | { _tag: "AccountNotFound"; accountId?: AccountId; emailAddress?: string }
  | { _tag: "DuplicateAccount"; provider: Provider; emailAddress: string }
```

Don't throw. Catch DB errors at the adapter boundary and classify into one of these tags. Uncaught throws are a backstop — the kernel catches them and treats as `Transient`.

### 7. Don't normalize

- `labels` are raw provider strings (Gmail's `INBOX`, `STARRED`, `CATEGORY_PROMOTIONS`). Don't try to map them into something cross-provider.
- `headers` keys are already lowercased by the parser; values are arrays. Preserve duplicates (RFC 5322 allows them).
- `bodyText` and `bodyHtml` may both be present, may both be empty. Don't infer one from the other.

## What's deliberately NOT in the contract

- No `deleteAccount` / `deleteMessage` (out of scope, see `out-of-scope.md`).
- No batch `commitMessages` across multiple accounts (single-account scope per call).
- No retention/pruning policies — the adapter author decides whether to keep `succeeded` and `failed` jobs around for audit, or sweep them on a schedule.
- No encryption-at-rest helpers — `MailboxAccount.credentials` is `Record<string, unknown>`, opaque to the core; encrypt at the adapter layer if your store needs it.

## Verifying with the conformance battery

```ts
// my-store.test.ts
import { describe } from "vitest"
import { runStoreConformance } from "mailbox-station-conformance"
import { createMyStore } from "./my-store.js"

describe("my-store", () => {
  runStoreConformance({
    name: "my-store",
    makeStore: async () => ({
      store: createMyStore({ /* fresh per-test schema or :memory: */ }),
      teardown: async () => { /* drop schema, close conn */ },
    }),
  })
})
```

If this passes, every invariant the kernel relies on is satisfied. The reference implementation is `createReferenceStore()` from the same package — useful to compare behavior side-by-side when debugging.
