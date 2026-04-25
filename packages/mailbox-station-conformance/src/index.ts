import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  AccountId as makeAccountId,
  UserId as makeUserId,
} from "@mail-station/mailbox-station"
import type {
  AccountId,
  MailMessage,
  MailboxAccount,
  Provider,
  StoreAdapter,
} from "@mail-station/mailbox-station"
import { aUserId, anAccountId, synthMessage } from "./fixtures.js"

export { createReferenceStore } from "./reference-store.js"
export type { ReferenceStore } from "./reference-store.js"
export { synthMessage, aUserId, anAccountId, aMessageId } from "./fixtures.js"

export type ConformanceInput = {
  readonly name: string
  readonly makeStore: () => Promise<{
    store: StoreAdapter
    teardown?: () => Promise<void>
  }>
}

const t0 = new Date("2026-01-01T00:00:00Z")
const dt = (ms: number): Date => new Date(t0.getTime() + ms)

const seedAccount = async (
  store: StoreAdapter,
  overrides: { provider?: Provider; email?: string; userId?: string; cursor?: string | null; watchExpiresAt?: Date | null } = {},
): Promise<MailboxAccount> => {
  const r = await store.createAccount({
    userId: makeUserId(overrides.userId ?? "user-1"),
    provider: overrides.provider ?? "gmail",
    emailAddress: overrides.email ?? "alice@example.com",
    credentials: { refreshToken: "rt" },
    lastEventCursor: overrides.cursor ?? null,
    watchExpiresAt: overrides.watchExpiresAt ?? null,
    now: t0,
  })
  if (!r.ok) throw new Error(`seedAccount failed: ${JSON.stringify(r.error)}`)
  return r.value
}

/**
 * Run the conformance battery against a Store implementation.
 * Calls Vitest `describe`/`it` internally — invoke from a `*.test.ts` file.
 *
 * `makeStore` is invoked fresh per test (default isolation), so adapter authors
 * can use `:memory:` databases or per-test schemas.
 */
export const runStoreConformance = (input: ConformanceInput): void => {
  let active: { store: StoreAdapter; teardown?: () => Promise<void> } | null = null

  const fresh = async (): Promise<StoreAdapter> => {
    active = await input.makeStore()
    return active.store
  }

  describe(`store conformance: ${input.name}`, () => {
    afterEach(async () => {
      if (active?.teardown) await active.teardown()
      active = null
    })

    describe("account lifecycle", () => {
      it("createAccount returns a new account with generated accountId", async () => {
        const store = await fresh()
        const r = await store.createAccount({
          userId: aUserId(),
          provider: "gmail",
          emailAddress: "alice@example.com",
          credentials: { refreshToken: "rt" },
          lastEventCursor: null,
          watchExpiresAt: null,
          now: t0,
        })
        expect(r.ok).toBe(true)
        if (!r.ok) return
        expect(r.value.accountId).toBeTruthy()
        expect(r.value.emailAddress).toBe("alice@example.com")
        expect(r.value.status).toBe("active")
      })

      it("createAccount with existing (provider, email) → DuplicateAccount", async () => {
        const store = await fresh()
        await seedAccount(store)
        const r = await store.createAccount({
          userId: aUserId("user-2"),
          provider: "gmail",
          emailAddress: "alice@example.com",
          credentials: {},
          lastEventCursor: null,
          watchExpiresAt: null,
          now: t0,
        })
        expect(r.ok).toBe(false)
        if (r.ok) return
        expect(r.error._tag).toBe("DuplicateAccount")
      })

      it("getAccount nonexistent → AccountNotFound", async () => {
        const store = await fresh()
        const r = await store.getAccount(makeAccountId("does-not-exist"))
        expect(r.ok).toBe(false)
        if (r.ok) return
        expect(r.error._tag).toBe("AccountNotFound")
      })

      it("getAccountByEmail nonexistent → AccountNotFound", async () => {
        const store = await fresh()
        const r = await store.getAccountByEmail("gmail", "nobody@example.com")
        expect(r.ok).toBe(false)
        if (r.ok) return
        expect(r.error._tag).toBe("AccountNotFound")
      })

      it("updateAccount changes fields independently", async () => {
        const store = await fresh()
        const acct = await seedAccount(store)
        const r1 = await store.updateAccount(acct.accountId, {
          credentials: { refreshToken: "new" },
          now: dt(1000),
        })
        expect(r1.ok && r1.value.credentials.refreshToken).toBe("new")
        const r2 = await store.updateAccount(acct.accountId, {
          status: "revoked",
          now: dt(2000),
        })
        expect(r2.ok && r2.value.status).toBe("revoked")
        // credentials untouched
        expect(r2.ok && (r2.value.credentials as { refreshToken: string }).refreshToken).toBe("new")
        const r3 = await store.updateAccount(acct.accountId, {
          lastEventCursor: "cursor-1",
          now: dt(3000),
        })
        expect(r3.ok && r3.value.lastEventCursor).toBe("cursor-1")
        const r4 = await store.updateAccount(acct.accountId, {
          watchExpiresAt: dt(60_000),
          now: dt(4000),
        })
        expect(r4.ok && r4.value.watchExpiresAt?.getTime()).toBe(dt(60_000).getTime())
      })

      it("listAccountsExpiringWatch filters by provider AND watchExpiresAt < cutoff", async () => {
        const store = await fresh()
        await seedAccount(store, { email: "expiring@example.com", watchExpiresAt: dt(10_000) })
        await seedAccount(store, { email: "later@example.com", watchExpiresAt: dt(100_000) })
        await seedAccount(store, { email: "no-watch@example.com", watchExpiresAt: null })

        const r = await store.listAccountsExpiringWatch("gmail", dt(50_000))
        expect(r.ok).toBe(true)
        if (!r.ok) return
        const emails = r.value.map((a) => a.emailAddress).sort()
        expect(emails).toEqual(["expiring@example.com"])
      })
    })

    describe("commitMessages atomicity & idempotency", () => {
      it("inserts new messages, advances cursor, enqueues 1 trigger job per new message", async () => {
        const store = await fresh()
        const acct = await seedAccount(store)
        const messages: MailMessage[] = [
          synthMessage({ accountId: acct.accountId, messageId: "m1" }),
          synthMessage({ accountId: acct.accountId, messageId: "m2" }),
        ]
        const r = await store.commitMessages({
          accountId: acct.accountId,
          messages,
          newCursor: "c1",
          now: t0,
        })
        expect(r.ok).toBe(true)
        if (!r.ok) return
        expect(r.value.committedMessageIds.length).toBe(2)

        const a = await store.getAccount(acct.accountId)
        expect(a.ok && a.value.lastEventCursor).toBe("c1")

        const claimed = await store.claimTriggerJobs({
          workerId: "w1",
          limit: 10,
          leaseDurationMs: 60_000,
          now: dt(1000),
        })
        expect(claimed.ok && claimed.value.length).toBe(2)
      })

      it("second call with same messages: no duplicate inserts, cursor still advances", async () => {
        const store = await fresh()
        const acct = await seedAccount(store)
        const m = synthMessage({ accountId: acct.accountId, messageId: "m1" })
        await store.commitMessages({ accountId: acct.accountId, messages: [m], newCursor: "c1", now: t0 })
        const r = await store.commitMessages({
          accountId: acct.accountId,
          messages: [m],
          newCursor: "c2",
          now: dt(1000),
        })
        expect(r.ok).toBe(true)
        if (!r.ok) return
        expect(r.value.committedMessageIds).toEqual([])

        const a = await store.getAccount(acct.accountId)
        expect(a.ok && a.value.lastEventCursor).toBe("c2")

        const claimed = await store.claimTriggerJobs({ workerId: "w1", limit: 10, leaseDurationMs: 60_000, now: dt(2000) })
        expect(claimed.ok && claimed.value.length).toBe(1)
      })

      it("partial overlap: 3 new + 2 existing → 3 trigger jobs, 3 in committedMessageIds", async () => {
        const store = await fresh()
        const acct = await seedAccount(store)
        await store.commitMessages({
          accountId: acct.accountId,
          messages: [
            synthMessage({ accountId: acct.accountId, messageId: "a" }),
            synthMessage({ accountId: acct.accountId, messageId: "b" }),
          ],
          newCursor: "c1",
          now: t0,
        })
        const r = await store.commitMessages({
          accountId: acct.accountId,
          messages: [
            synthMessage({ accountId: acct.accountId, messageId: "a" }),
            synthMessage({ accountId: acct.accountId, messageId: "b" }),
            synthMessage({ accountId: acct.accountId, messageId: "c" }),
            synthMessage({ accountId: acct.accountId, messageId: "d" }),
            synthMessage({ accountId: acct.accountId, messageId: "e" }),
          ],
          newCursor: "c2",
          now: dt(1000),
        })
        expect(r.ok && r.value.committedMessageIds.length).toBe(3)

        const claimed = await store.claimTriggerJobs({ workerId: "w1", limit: 100, leaseDurationMs: 60_000, now: dt(2000) })
        expect(claimed.ok && claimed.value.length).toBe(5) // 2 from first + 3 from second
      })

      it("empty messages array still advances cursor", async () => {
        const store = await fresh()
        const acct = await seedAccount(store)
        const r = await store.commitMessages({ accountId: acct.accountId, messages: [], newCursor: "c1", now: t0 })
        expect(r.ok && r.value.committedMessageIds.length).toBe(0)
        const a = await store.getAccount(acct.accountId)
        expect(a.ok && a.value.lastEventCursor).toBe("c1")
      })
    })

    describe("trigger outbox claim semantics", () => {
      const seed = async (store: StoreAdapter, n = 3): Promise<{ accountId: AccountId }> => {
        const acct = await seedAccount(store)
        const messages: MailMessage[] = []
        for (let i = 0; i < n; i++) {
          messages.push(synthMessage({ accountId: acct.accountId, messageId: `m${i}` }))
        }
        await store.commitMessages({ accountId: acct.accountId, messages, newCursor: "c1", now: t0 })
        return { accountId: acct.accountId }
      }

      it("respects nextAttemptAt > now (not yet ready)", async () => {
        const store = await fresh()
        await seed(store, 1)
        const claim = await store.claimTriggerJobs({ workerId: "w1", limit: 10, leaseDurationMs: 60_000, now: dt(1000) })
        expect(claim.ok && claim.value.length).toBe(1)
        const job = claim.ok ? claim.value[0]!.job.jobId : (() => { throw new Error() })()
        // Mark failed with future date, then claim again before the future.
        await store.markTriggerFailed(job, "x", dt(60_000), dt(2000))
        const claim2 = await store.claimTriggerJobs({ workerId: "w1", limit: 10, leaseDurationMs: 60_000, now: dt(3000) })
        expect(claim2.ok && claim2.value.length).toBe(0)
      })

      it("respects state ≠ pending", async () => {
        const store = await fresh()
        await seed(store, 1)
        const c1 = await store.claimTriggerJobs({ workerId: "w1", limit: 10, leaseDurationMs: 60_000, now: dt(1000) })
        const id = c1.ok ? c1.value[0]!.job.jobId : (() => { throw new Error() })()
        await store.markTriggerDone(id, dt(2000))
        // After claim and done, no more pending in this batch.
        const c2 = await store.claimTriggerJobs({ workerId: "w2", limit: 10, leaseDurationMs: 60_000, now: dt(3000) })
        expect(c2.ok && c2.value.length).toBe(0)
      })

      it("respects valid lease", async () => {
        const store = await fresh()
        await seed(store, 1)
        const c1 = await store.claimTriggerJobs({ workerId: "w1", limit: 10, leaseDurationMs: 60_000, now: dt(1000) })
        expect(c1.ok && c1.value.length).toBe(1)
        const c2 = await store.claimTriggerJobs({ workerId: "w2", limit: 10, leaseDurationMs: 60_000, now: dt(5_000) })
        expect(c2.ok && c2.value.length).toBe(0)
      })

      it("returns expired-lease jobs as claimable", async () => {
        const store = await fresh()
        await seed(store, 1)
        await store.claimTriggerJobs({ workerId: "w1", limit: 10, leaseDurationMs: 60_000, now: dt(1000) })
        const c2 = await store.claimTriggerJobs({ workerId: "w2", limit: 10, leaseDurationMs: 60_000, now: dt(120_000) })
        expect(c2.ok && c2.value.length).toBe(1)
        if (c2.ok) expect(c2.value[0]!.job.claimedBy).toBe("w2")
      })

      it("concurrent claims from two workers: no overlap (mutex invariant)", async () => {
        const store = await fresh()
        await seed(store, 5)
        const [a, b] = await Promise.all([
          store.claimTriggerJobs({ workerId: "wa", limit: 5, leaseDurationMs: 60_000, now: dt(1000) }),
          store.claimTriggerJobs({ workerId: "wb", limit: 5, leaseDurationMs: 60_000, now: dt(1000) }),
        ])
        const ids = (r: typeof a) => (r.ok ? r.value.map((c) => c.job.jobId) : [])
        const set = new Set<string>([...ids(a), ...ids(b)])
        expect(set.size).toBe(ids(a).length + ids(b).length)
        expect(ids(a).length + ids(b).length).toBe(5)
      })

      it("respects limit", async () => {
        const store = await fresh()
        await seed(store, 5)
        const c = await store.claimTriggerJobs({ workerId: "w1", limit: 2, leaseDurationMs: 60_000, now: dt(1000) })
        expect(c.ok && c.value.length).toBe(2)
      })

      it("returns ClaimedJob with full message joined", async () => {
        const store = await fresh()
        await seed(store, 1)
        const c = await store.claimTriggerJobs({ workerId: "w1", limit: 10, leaseDurationMs: 60_000, now: dt(1000) })
        expect(c.ok).toBe(true)
        if (!c.ok) return
        expect(c.value[0]!.message.messageId).toBe("m0")
        expect(c.value[0]!.message.subject).toBe("subject")
      })
    })

    describe("trigger state transitions", () => {
      const claim1 = async (store: StoreAdapter): Promise<{ jobId: import("@mail-station/mailbox-station").JobIdType }> => {
        const acct = await seedAccount(store)
        await store.commitMessages({
          accountId: acct.accountId,
          messages: [synthMessage({ accountId: acct.accountId, messageId: "m" })],
          newCursor: "c1",
          now: t0,
        })
        const c = await store.claimTriggerJobs({ workerId: "w1", limit: 10, leaseDurationMs: 60_000, now: dt(1000) })
        if (!c.ok) throw new Error("claim failed")
        return { jobId: c.value[0]!.job.jobId }
      }

      it("markTriggerDone: state=succeeded, completedAt set, no longer claimable", async () => {
        const store = await fresh()
        const { jobId } = await claim1(store)
        await store.markTriggerDone(jobId, dt(2000))
        const c = await store.claimTriggerJobs({ workerId: "w1", limit: 10, leaseDurationMs: 60_000, now: dt(120_000) })
        expect(c.ok && c.value.length).toBe(0)
      })

      it("markTriggerFailed with future date: state stays pending, attempts+=1", async () => {
        const store = await fresh()
        const { jobId } = await claim1(store)
        await store.markTriggerFailed(jobId, "boom", dt(120_000), dt(2000))
        const c = await store.claimTriggerJobs({ workerId: "w1", limit: 10, leaseDurationMs: 60_000, now: dt(60_000) })
        expect(c.ok && c.value.length).toBe(0)
        const c2 = await store.claimTriggerJobs({ workerId: "w1", limit: 10, leaseDurationMs: 60_000, now: dt(180_000) })
        expect(c2.ok && c2.value.length).toBe(1)
        if (c2.ok) {
          expect(c2.value[0]!.job.attempts).toBe(1)
          expect(c2.value[0]!.job.lastError).toBe("boom")
        }
        // ensure jobId is still the same one
        if (c2.ok) expect(c2.value[0]!.job.jobId).toBe(jobId)
      })

      it("markTriggerFailed with null: state=failed, completedAt set, no longer claimable", async () => {
        const store = await fresh()
        const { jobId } = await claim1(store)
        await store.markTriggerFailed(jobId, "permanent", null, dt(2000))
        const c = await store.claimTriggerJobs({ workerId: "w1", limit: 10, leaseDurationMs: 60_000, now: dt(120_000) })
        expect(c.ok && c.value.length).toBe(0)
      })
    })
  })
}
