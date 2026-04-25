import { describe, expect, it } from "vitest"
import type { MailMessage, StoreAdapter } from "mailbox-station"
import { synthMessage } from "../fixtures.js"
import { dt, seedAccount, t0 } from "./_helpers.js"

export const commitMessagesTests = (fresh: () => Promise<StoreAdapter>): void => {
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

    it("second call with same messages: no duplicate inserts, cursor still advances, committedMessageIds is empty", async () => {
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
}
