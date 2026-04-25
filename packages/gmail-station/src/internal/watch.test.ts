import { describe, expect, it } from "vitest"
import { ok, err, UserId } from "@mail-station/mailbox-station"
import { createReferenceStore } from "@mail-station/mailbox-station-conformance"
import { createWatchManager } from "./watch.js"
import type { GmailClient, GmailClientFactory, ResolvedGmailConfig } from "./types.js"

const t0 = new Date("2026-01-01T00:00:00Z")
const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const baseConfig = (overrides: Partial<ResolvedGmailConfig> = {}): ResolvedGmailConfig => ({
  googleClientId: "id",
  googleClientSecret: "secret",
  gcpProjectId: "proj",
  pubsubTopic: "projects/proj/topics/topic",
  pubsubSubscription: "sub",
  labelFilter: ["INBOX"],
  pullConcurrency: 4,
  fetchConcurrency: 8,
  renewalWindowMs: 24 * 3600_000,
  pubsubAuth: { kind: "adc" },
  ...overrides,
})

describe("watch manager: register", () => {
  it("happy path → store account, return accountId", async () => {
    const store = createReferenceStore()
    const factory: GmailClientFactory = (): GmailClient => ({
      watch: async () => ok({ historyId: "100", expiration: new Date(t0.getTime() + 7 * 86_400_000) }),
      stop: async () => ok(undefined),
      historyList: async () => ok({}),
      messageGet: async () => ok({}),
    })
    const wm = createWatchManager({
      store,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => t0,
      config: baseConfig({ clientFactory: factory }),
    })
    const r = await wm.register({ userId: UserId("u-1"), emailAddress: "alice@example.com", refreshToken: "rt" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const a = await store.getAccount(r.value.accountId)
    expect(a.ok && a.value.emailAddress).toBe("alice@example.com")
    expect(a.ok && a.value.lastEventCursor).toBe("100")
  })

  it("invalid_grant from watch → InvalidGrant; never persists", async () => {
    const store = createReferenceStore()
    let watchCalled = 0
    const factory: GmailClientFactory = (): GmailClient => ({
      watch: async () => {
        watchCalled++
        return err({ _tag: "CredentialsRevoked", accountId: undefined as unknown as never, reason: "invalid_grant" })
      },
      stop: async () => ok(undefined),
      historyList: async () => ok({}),
      messageGet: async () => ok({}),
    })
    const wm = createWatchManager({
      store,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => t0,
      config: baseConfig({ clientFactory: factory }),
    })
    const r = await wm.register({ userId: UserId("u-1"), emailAddress: "alice@example.com", refreshToken: "rt" })
    expect(!r.ok && r.error._tag).toBe("InvalidGrant")
    expect(watchCalled).toBe(1)
    expect(store._accounts().length).toBe(0)
  })

  it("duplicate account: pre-flight check returns DuplicateAccount, no watch call", async () => {
    const store = createReferenceStore()
    await store.createAccount({
      userId: UserId("u-1"),
      provider: "gmail",
      emailAddress: "alice@example.com",
      credentials: { refreshToken: "x" },
      lastEventCursor: null,
      watchExpiresAt: null,
      now: t0,
    })
    let watchCalled = 0
    const factory: GmailClientFactory = (): GmailClient => ({
      watch: async () => {
        watchCalled++
        return ok({ historyId: "1", expiration: new Date() })
      },
      stop: async () => ok(undefined),
      historyList: async () => ok({}),
      messageGet: async () => ok({}),
    })
    const wm = createWatchManager({
      store,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => t0,
      config: baseConfig({ clientFactory: factory }),
    })
    const r = await wm.register({ userId: UserId("u-2"), emailAddress: "alice@example.com", refreshToken: "rt" })
    expect(!r.ok && r.error._tag).toBe("DuplicateAccount")
    expect(watchCalled).toBe(0)
  })

  it("persist failure invokes compensating users.stop", async () => {
    let stopCalled = 0
    const store = createReferenceStore()
    // Inject a Store that fails createAccount. We wrap reference store and override.
    const failingStore = {
      ...store,
      createAccount: async () => err({ _tag: "Permanent", message: "db down" } as const),
    } as unknown as typeof store
    const factory: GmailClientFactory = (): GmailClient => ({
      watch: async () => ok({ historyId: "1", expiration: new Date() }),
      stop: async () => {
        stopCalled++
        return ok(undefined)
      },
      historyList: async () => ok({}),
      messageGet: async () => ok({}),
    })
    const wm = createWatchManager({
      store: failingStore,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => t0,
      config: baseConfig({ clientFactory: factory }),
    })
    const r = await wm.register({ userId: UserId("u-1"), emailAddress: "alice@example.com", refreshToken: "rt" })
    expect(!r.ok && r.error._tag).toBe("StoreError")
    expect(stopCalled).toBe(1)
  })
})

describe("watch manager: renewExpiringWatches", () => {
  it("renews expiring accounts, isolates per-account failure", async () => {
    const store = createReferenceStore()
    await store.createAccount({
      userId: UserId("u-1"),
      provider: "gmail",
      emailAddress: "ok@example.com",
      credentials: { refreshToken: "good" },
      lastEventCursor: "old",
      watchExpiresAt: new Date(t0.getTime() + 1_000),
      now: t0,
    })
    await store.createAccount({
      userId: UserId("u-2"),
      provider: "gmail",
      emailAddress: "bad@example.com",
      credentials: { refreshToken: "bad" },
      lastEventCursor: "old",
      watchExpiresAt: new Date(t0.getTime() + 1_000),
      now: t0,
    })
    const factory: GmailClientFactory = (creds): GmailClient => ({
      watch: async () => {
        if (creds.refreshToken === "bad") {
          return err({ _tag: "ProviderTransient", message: "5xx" })
        }
        return ok({ historyId: "200", expiration: new Date(t0.getTime() + 7 * 86_400_000) })
      },
      stop: async () => ok(undefined),
      historyList: async () => ok({}),
      messageGet: async () => ok({}),
    })

    const wm = createWatchManager({
      store,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => t0,
      config: baseConfig({ clientFactory: factory, renewalWindowMs: 60_000 }),
    })
    const r = await wm.renewExpiringWatches()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.renewed).toBe(1)
    expect(r.value.failed).toBe(1)
    expect(r.value.revoked).toBe(0)
  })

  it("invalid_grant during renewal flips account to revoked", async () => {
    const store = createReferenceStore()
    const seed = await store.createAccount({
      userId: UserId("u"),
      provider: "gmail",
      emailAddress: "x@example.com",
      credentials: { refreshToken: "stale" },
      lastEventCursor: "old",
      watchExpiresAt: new Date(t0.getTime() + 1_000),
      now: t0,
    })
    if (!seed.ok) throw new Error("seed failed")
    const factory: GmailClientFactory = (): GmailClient => ({
      watch: async () => err({ _tag: "CredentialsRevoked", accountId: undefined as unknown as never, reason: "invalid_grant" }),
      stop: async () => ok(undefined),
      historyList: async () => ok({}),
      messageGet: async () => ok({}),
    })
    const wm = createWatchManager({
      store,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => t0,
      config: baseConfig({ clientFactory: factory, renewalWindowMs: 60_000 }),
    })
    const r = await wm.renewExpiringWatches()
    expect(r.ok && r.value.revoked).toBe(1)
    const a = await store.getAccount(seed.value.accountId)
    expect(a.ok && a.value.status).toBe("revoked")
  })
})
