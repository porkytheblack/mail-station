import { describe, expect, it } from "vitest"
import { AccountId as makeAccountId } from "@mail-station/mailbox-station"
import type { StoreAdapter } from "@mail-station/mailbox-station"
import { aUserId } from "../fixtures.js"
import { dt, seedAccount, t0 } from "./_helpers.js"

export const accountLifecycleTests = (fresh: () => Promise<StoreAdapter>): void => {
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

    it("updateAccount changes credentials, status, cursor, watchExpiresAt independently", async () => {
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
}
