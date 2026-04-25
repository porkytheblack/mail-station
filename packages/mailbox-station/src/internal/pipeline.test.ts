import { describe, expect, it } from "vitest"
import {
  AccountId as makeAccountId,
  MessageId as makeMessageId,
  ThreadId as makeThreadId,
  UserId as makeUserId,
} from "./ids.js"
import { ok, err } from "./result.js"
import { createPipeline } from "./pipeline.js"
import type {
  MailMessage,
  MailboxAccount,
  MailboxEvent,
  MessageResolver,
  ResolverError,
  StoreAdapter,
  StoreError,
} from "./types.js"

const t0 = new Date("2026-01-01T00:00:00Z")

const stubLogger = () => {
  const log: Array<{ level: string; event: string; fields: Record<string, unknown> | undefined }> = []
  return {
    log,
    logger: {
      debug: (event: string, fields?: Record<string, unknown>) => log.push({ level: "debug", event, fields }),
      info: (event: string, fields?: Record<string, unknown>) => log.push({ level: "info", event, fields }),
      warn: (event: string, fields?: Record<string, unknown>) => log.push({ level: "warn", event, fields }),
      error: (event: string, fields?: Record<string, unknown>) => log.push({ level: "error", event, fields }),
    },
  }
}

const accountId = makeAccountId("acc-1")
const userId = makeUserId("user-1")

const stubAccount: MailboxAccount = {
  accountId,
  userId,
  provider: "gmail",
  emailAddress: "alice@example.com",
  status: "active",
  credentials: {},
  lastEventCursor: null,
  watchExpiresAt: null,
  createdAt: t0,
  updatedAt: t0,
}

const stubMessage: MailMessage = {
  messageId: makeMessageId("m1"),
  threadId: makeThreadId("t1"),
  accountId,
  provider: "gmail",
  from: { name: null, email: "from@example.com" },
  to: [],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: "hi",
  bodyText: "",
  bodyHtml: "",
  headers: {},
  attachments: [],
  labels: [],
  receivedAt: t0,
  sentAt: null,
  sizeEstimate: 1,
}

const event: MailboxEvent = { eventId: "e1", providerPayload: null, receivedAt: t0 }

const stubStore = (overrides: Partial<StoreAdapter> = {}): StoreAdapter & { calls: Record<string, number> } => {
  const calls = { commitMessages: 0, updateAccount: 0 }
  const base: StoreAdapter = {
    createAccount: async () => err({ _tag: "Permanent", message: "n/a" }),
    getAccount: async () => err({ _tag: "AccountNotFound", accountId }),
    getAccountByEmail: async () => err({ _tag: "AccountNotFound" }),
    updateAccount: async () => {
      calls.updateAccount++
      return ok(stubAccount)
    },
    listAccountsExpiringWatch: async () => ok([]),
    commitMessages: async () => {
      calls.commitMessages++
      return ok({ committedMessageIds: [stubMessage.messageId] })
    },
    claimTriggerJobs: async () => ok([]),
    markTriggerDone: async () => ok(undefined),
    markTriggerFailed: async () => ok(undefined),
  }
  return { ...base, ...overrides, calls } as StoreAdapter & { calls: Record<string, number> }
}

const makeResolver = (result: () => Promise<{ ok: true; value: { accountId: typeof accountId; messages: ReadonlyArray<MailMessage>; newCursor: string } } | { ok: false; error: ResolverError }>): MessageResolver => ({
  resolve: result,
})

describe("pipeline", () => {
  it("commits and acks on happy path", async () => {
    const { logger, log } = stubLogger()
    const store = stubStore()
    const resolver = makeResolver(async () => ok({ accountId, messages: [stubMessage], newCursor: "c1" }))
    const p = createPipeline({ store, resolver, logger, clock: () => t0 })
    const decision = await p.processEvent(event)
    expect(decision).toBe("ack")
    expect(store.calls.commitMessages).toBe(1)
    expect(log.find((l) => l.event === "event.committed")).toBeTruthy()
  })

  it("acks MalformedNotification (warn)", async () => {
    const { logger } = stubLogger()
    const resolver = makeResolver(async () => err({ _tag: "MalformedNotification", details: "bad" }))
    const p = createPipeline({ store: stubStore(), resolver, logger, clock: () => t0 })
    expect(await p.processEvent(event)).toBe("ack")
  })

  it("acks AccountNotFound (info)", async () => {
    const { logger } = stubLogger()
    const resolver = makeResolver(async () => err({ _tag: "AccountNotFound", emailAddress: "x@y" }))
    const p = createPipeline({ store: stubStore(), resolver, logger, clock: () => t0 })
    expect(await p.processEvent(event)).toBe("ack")
  })

  it("acks AccountPaused/Revoked", async () => {
    const { logger } = stubLogger()
    const p1 = createPipeline({
      store: stubStore(),
      resolver: makeResolver(async () => err({ _tag: "AccountPaused", accountId })),
      logger,
      clock: () => t0,
    })
    expect(await p1.processEvent(event)).toBe("ack")
    const p2 = createPipeline({
      store: stubStore(),
      resolver: makeResolver(async () => err({ _tag: "AccountRevoked", accountId })),
      logger,
      clock: () => t0,
    })
    expect(await p2.processEvent(event)).toBe("ack")
  })

  it("acks CredentialsRevoked AND mutates account.status", async () => {
    const { logger } = stubLogger()
    const store = stubStore()
    const resolver = makeResolver(async () => err({ _tag: "CredentialsRevoked", accountId, reason: "invalid_grant" }))
    const p = createPipeline({ store, resolver, logger, clock: () => t0 })
    expect(await p.processEvent(event)).toBe("ack")
    expect(store.calls.updateAccount).toBe(1)
  })

  it("nacks ProviderTransient", async () => {
    const { logger } = stubLogger()
    const resolver = makeResolver(async () => err({ _tag: "ProviderTransient", message: "5xx" }))
    const p = createPipeline({ store: stubStore(), resolver, logger, clock: () => t0 })
    expect(await p.processEvent(event)).toBe("nack")
  })

  it("acks ProviderPermanent", async () => {
    const { logger } = stubLogger()
    const resolver = makeResolver(async () => err({ _tag: "ProviderPermanent", message: "401" }))
    const p = createPipeline({ store: stubStore(), resolver, logger, clock: () => t0 })
    expect(await p.processEvent(event)).toBe("ack")
  })

  it("nacks Store.Transient during commit", async () => {
    const { logger } = stubLogger()
    const store = stubStore({
      commitMessages: async () => err<StoreError>({ _tag: "Transient", message: "db blip" }),
    })
    const resolver = makeResolver(async () => ok({ accountId, messages: [stubMessage], newCursor: "c1" }))
    const p = createPipeline({ store, resolver, logger, clock: () => t0 })
    expect(await p.processEvent(event)).toBe("nack")
  })

  it("acks Store.Permanent during commit + emits alarm log", async () => {
    const { logger, log } = stubLogger()
    const store = stubStore({
      commitMessages: async () => err<StoreError>({ _tag: "Permanent", message: "schema mismatch" }),
    })
    const resolver = makeResolver(async () => ok({ accountId, messages: [stubMessage], newCursor: "c1" }))
    const p = createPipeline({ store, resolver, logger, clock: () => t0 })
    expect(await p.processEvent(event)).toBe("ack")
    const dropped = log.find((l) => l.event === "event.dropped")
    expect(dropped?.fields?.alarm).toBe(true)
  })

  it("converts thrown resolver into ProviderTransient → nack", async () => {
    const { logger } = stubLogger()
    const resolver: MessageResolver = {
      resolve: async () => {
        throw new Error("boom")
      },
    }
    const p = createPipeline({ store: stubStore(), resolver, logger, clock: () => t0 })
    expect(await p.processEvent(event)).toBe("nack")
  })

  it("empty messages still commits and acks", async () => {
    const { logger } = stubLogger()
    const store = stubStore({
      commitMessages: async () => ok({ committedMessageIds: [] }),
    })
    const resolver = makeResolver(async () => ok({ accountId, messages: [], newCursor: "c1" }))
    const p = createPipeline({ store, resolver, logger, clock: () => t0 })
    expect(await p.processEvent(event)).toBe("ack")
  })
})
