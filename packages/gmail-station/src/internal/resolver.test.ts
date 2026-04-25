import { describe, expect, it } from "vitest"
import { ok, err, UserId } from "@mail-station/mailbox-station"
import type { gmail_v1 } from "@googleapis/gmail"
import { createGmailResolver } from "./resolver.js"
import { createReferenceStore } from "@mail-station/mailbox-station-conformance"
import type { GmailClient, GmailClientFactory, ResolvedGmailConfig } from "./types.js"

const t0 = new Date("2026-01-01T00:00:00Z")
const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const baseConfig = (overrides: Partial<ResolvedGmailConfig> = {}): ResolvedGmailConfig => ({
  googleClientId: "id",
  googleClientSecret: "secret",
  gcpProjectId: "proj",
  pubsubTopic: "topic",
  pubsubSubscription: "sub",
  labelFilter: ["INBOX"],
  pullConcurrency: 4,
  fetchConcurrency: 8,
  renewalWindowMs: 24 * 3600_000,
  pubsubAuth: { kind: "adc" },
  ...overrides,
})

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64url")

const fakeMessage = (id: string, labels: string[] = ["INBOX"]): gmail_v1.Schema$Message => ({
  id,
  threadId: `t-${id}`,
  labelIds: labels,
  internalDate: "1735689600000",
  sizeEstimate: 100,
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "Subject", value: `subject ${id}` },
      { name: "From", value: "alice@example.com" },
    ],
    body: { data: b64(`body of ${id}`) },
  },
})

const fakeFactory = (
  pages: gmail_v1.Schema$ListHistoryResponse[] | (() => gmail_v1.Schema$ListHistoryResponse[]),
  messages: Record<string, gmail_v1.Schema$Message | "404"> = {},
  options: { historyGone?: boolean } = {},
): GmailClientFactory => {
  return () => {
    let pageIdx = 0
    const get = typeof pages === "function" ? pages() : pages
    const client: GmailClient = {
      watch: async () => ok({ historyId: "999", expiration: new Date(0) }),
      stop: async () => ok(undefined),
      historyList: async () => {
        if (options.historyGone) return err({ _tag: "HistoryGone" } as const)
        const page = get[pageIdx]
        pageIdx++
        if (!page) return ok({})
        return ok(page)
      },
      messageGet: async (id) => {
        const v = messages[id]
        if (v === "404") return err({ _tag: "MessageGone" } as const)
        if (v) return ok(v)
        return ok(fakeMessage(id))
      },
    }
    return client
  }
}

const seedAccount = async (store: ReturnType<typeof createReferenceStore>) => {
  const r = await store.createAccount({
    userId: UserId("u-1"),
    provider: "gmail",
    emailAddress: "alice@example.com",
    credentials: { refreshToken: "rt" },
    lastEventCursor: "100",
    watchExpiresAt: null,
    now: t0,
  })
  if (!r.ok) throw new Error("seed failed")
  return r.value
}

const event = (historyId: string) => ({
  eventId: "e1",
  providerPayload: Buffer.from(JSON.stringify({ emailAddress: "alice@example.com", historyId }), "utf-8"),
  receivedAt: t0,
})

describe("gmail resolver", () => {
  it("paginates history.list, dedups across entries, fetches messages, returns lastHistoryId as cursor", async () => {
    const store = createReferenceStore()
    await seedAccount(store)
    const pages: gmail_v1.Schema$ListHistoryResponse[] = [
      {
        history: [
          { messagesAdded: [{ message: { id: "a", labelIds: ["INBOX"] } }] },
          { messagesAdded: [{ message: { id: "b", labelIds: ["INBOX"] } }] },
        ],
        historyId: "200",
        nextPageToken: "p2",
      },
      {
        history: [
          { messagesAdded: [{ message: { id: "a", labelIds: ["INBOX"] } }, { message: { id: "c", labelIds: ["INBOX"] } }] },
        ],
        historyId: "300",
      },
    ]
    const config = baseConfig({ clientFactory: fakeFactory(pages) })
    const resolver = createGmailResolver({ store, pipeline: { processEvent: async () => "ack" }, logger: noopLogger, clock: () => t0, config })

    const r = await resolver.resolve(event("200"))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.newCursor).toBe("300")
    expect(r.value.messages.map((m) => m.messageId).sort()).toEqual(["a", "b", "c"])
  })

  it("HistoryGone: returns empty messages, advances cursor to notification's historyId", async () => {
    const store = createReferenceStore()
    await seedAccount(store)
    const config = baseConfig({ clientFactory: fakeFactory([], {}, { historyGone: true }) })
    const resolver = createGmailResolver({ store, pipeline: { processEvent: async () => "ack" }, logger: noopLogger, clock: () => t0, config })
    const r = await resolver.resolve(event("777"))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.messages).toEqual([])
    expect(r.value.newCursor).toBe("777")
  })

  it("messages.get 404 → skipped, others succeed", async () => {
    const store = createReferenceStore()
    await seedAccount(store)
    const pages: gmail_v1.Schema$ListHistoryResponse[] = [
      {
        history: [{ messagesAdded: [{ message: { id: "a", labelIds: ["INBOX"] } }, { message: { id: "b", labelIds: ["INBOX"] } }] }],
        historyId: "200",
      },
    ]
    const config = baseConfig({ clientFactory: fakeFactory(pages, { a: "404" }) })
    const resolver = createGmailResolver({ store, pipeline: { processEvent: async () => "ack" }, logger: noopLogger, clock: () => t0, config })
    const r = await resolver.resolve(event("100"))
    expect(r.ok && r.value.messages.map((m) => m.messageId)).toEqual(["b"])
  })

  it("multi-label: client-side label filter applies", async () => {
    const store = createReferenceStore()
    await seedAccount(store)
    const pages: gmail_v1.Schema$ListHistoryResponse[] = [
      {
        history: [
          { messagesAdded: [{ message: { id: "a", labelIds: ["INBOX"] } }] },
          { messagesAdded: [{ message: { id: "b", labelIds: ["SPAM"] } }] },
          { messagesAdded: [{ message: { id: "c", labelIds: ["INBOX", "Important"] } }] },
        ],
        historyId: "200",
      },
    ]
    const messages: Record<string, gmail_v1.Schema$Message> = {
      a: fakeMessage("a", ["INBOX"]),
      b: fakeMessage("b", ["SPAM"]),
      c: fakeMessage("c", ["INBOX", "Important"]),
    }
    const config = baseConfig({
      labelFilter: ["INBOX", "Important"],
      clientFactory: fakeFactory(pages, messages),
    })
    const resolver = createGmailResolver({ store, pipeline: { processEvent: async () => "ack" }, logger: noopLogger, clock: () => t0, config })
    const r = await resolver.resolve(event("100"))
    expect(r.ok && r.value.messages.map((m) => m.messageId).sort()).toEqual(["a", "c"])
  })

  it("AccountNotFound when no matching email", async () => {
    const store = createReferenceStore()
    const config = baseConfig({ clientFactory: fakeFactory([]) })
    const resolver = createGmailResolver({ store, pipeline: { processEvent: async () => "ack" }, logger: noopLogger, clock: () => t0, config })
    const r = await resolver.resolve(event("100"))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error._tag).toBe("AccountNotFound")
  })

  it("paused account → AccountPaused", async () => {
    const store = createReferenceStore()
    const a = await seedAccount(store)
    await store.updateAccount(a.accountId, { status: "paused", now: t0 })
    const config = baseConfig({ clientFactory: fakeFactory([]) })
    const resolver = createGmailResolver({ store, pipeline: { processEvent: async () => "ack" }, logger: noopLogger, clock: () => t0, config })
    const r = await resolver.resolve(event("100"))
    expect(!r.ok && r.error._tag).toBe("AccountPaused")
  })

  it("malformed payload → MalformedNotification", async () => {
    const store = createReferenceStore()
    const config = baseConfig({ clientFactory: fakeFactory([]) })
    const resolver = createGmailResolver({ store, pipeline: { processEvent: async () => "ack" }, logger: noopLogger, clock: () => t0, config })
    const r = await resolver.resolve({ eventId: "e1", providerPayload: Buffer.from("nope"), receivedAt: t0 })
    expect(!r.ok && r.error._tag).toBe("MalformedNotification")
  })

  it("non-404 fetch failure aborts whole event", async () => {
    const store = createReferenceStore()
    await seedAccount(store)
    const pages: gmail_v1.Schema$ListHistoryResponse[] = [
      {
        history: [{ messagesAdded: [{ message: { id: "a", labelIds: ["INBOX"] } }, { message: { id: "b", labelIds: ["INBOX"] } }] }],
        historyId: "200",
      },
    ]
    const factory: GmailClientFactory = () => ({
      watch: async () => ok({ historyId: "1", expiration: new Date(0) }),
      stop: async () => ok(undefined),
      historyList: async () => ok(pages[0]!),
      messageGet: async (id) => {
        if (id === "a") return err({ _tag: "ProviderTransient", message: "5xx" })
        return ok(fakeMessage(id))
      },
    })
    const config = baseConfig({ clientFactory: factory })
    const resolver = createGmailResolver({ store, pipeline: { processEvent: async () => "ack" }, logger: noopLogger, clock: () => t0, config })
    const r = await resolver.resolve(event("100"))
    expect(!r.ok && r.error._tag).toBe("ProviderTransient")
  })
})
