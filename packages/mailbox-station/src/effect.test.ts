import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { createReferenceStore, synthMessage } from "mailbox-station-conformance"
import { createStation } from "./internal/station.js"
import { createStationEffect } from "./effect.js"
import { ok, UserId } from "./index.js"
import type {
  MailMessage,
  MailboxEvent,
  MessageHandlerFn,
  ProviderFactory,
} from "./internal/types.js"

const t0 = new Date("2026-01-01T00:00:00Z")

const seed = async (
  store: ReturnType<typeof createReferenceStore>,
): Promise<{ accountId: ReturnType<typeof createReferenceStore> extends infer _ ? import("./index.js").AccountIdType : never; messages: ReadonlyArray<MailMessage> }> => {
  const acct = await store.createAccount({
    userId: UserId("u-1"),
    provider: "gmail",
    emailAddress: "alice@example.com",
    credentials: { refreshToken: "rt" },
    lastEventCursor: null,
    watchExpiresAt: null,
    now: t0,
  })
  if (!acct.ok) throw new Error("seed failed")
  const messages: ReadonlyArray<MailMessage> = [
    synthMessage({ accountId: acct.value.accountId, messageId: "m1", subject: "alpha" }),
    synthMessage({ accountId: acct.value.accountId, messageId: "m2", subject: "beta" }),
  ]
  return { accountId: acct.value.accountId, messages }
}

const buildFakeProvider = (
  accountId: import("./index.js").AccountIdType,
  messages: ReadonlyArray<MailMessage>,
): ProviderFactory<{}> => ({
  build: () => ({
    api: {},
    resolver: {
      resolve: async () => ok({ accountId, messages, newCursor: "100" }),
    },
    start: async () => {},
    stop: async () => {},
    wait: async () => {},
  }),
})

const runScenario = async (
  build: () => Promise<{
    start: () => Promise<void>
    stop: () => Promise<void>
    processEvent: (e: MailboxEvent) => Promise<"ack" | "nack">
    handled: { current: string[] }
  }>,
): Promise<{ decision: "ack" | "nack"; handled: string[] }> => {
  const ctx = await build()
  await ctx.start()
  const decision = await ctx.processEvent({ eventId: "e1", providerPayload: null, receivedAt: t0 })
  // Drain worker.
  const deadline = Date.now() + 2000
  while (ctx.handled.current.length < 2 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10))
  }
  await ctx.stop()
  return { decision, handled: [...ctx.handled.current].sort() }
}

describe("/effect <-> Promise parity", () => {
  it("processEvent + worker handle same fake provider with identical observable behavior", async () => {
    // Promise API
    const promiseRun = await runScenario(async () => {
      const store = createReferenceStore()
      const { accountId, messages } = await seed(store)
      const handled: { current: string[] } = { current: [] }
      const handler: MessageHandlerFn = async (m) => {
        handled.current.push(m.subject)
        return ok(undefined)
      }
      const station = createStation({
        store,
        handler,
        providers: { fake: buildFakeProvider(accountId, messages) },
        config: { idlePollIntervalMs: 5, triggerConcurrency: 1, claimBatchSize: 5 },
      })
      return {
        start: () => station.start(),
        stop: () => station.stop(),
        processEvent: (e) => station.pipeline.processEvent(e),
        handled,
      }
    })

    // Effect API — same kernel, lifted into Effect, run via runPromise.
    const effectRun = await runScenario(async () => {
      const store = createReferenceStore()
      const { accountId, messages } = await seed(store)
      const handled: { current: string[] } = { current: [] }
      const handler: MessageHandlerFn = async (m) => {
        handled.current.push(m.subject)
        return ok(undefined)
      }
      const station = await Effect.runPromise(
        createStationEffect({
          store,
          handler,
          providers: { fake: buildFakeProvider(accountId, messages) },
          config: { idlePollIntervalMs: 5, triggerConcurrency: 1, claimBatchSize: 5 },
        }),
      )
      return {
        start: () => Effect.runPromise(station.start),
        stop: () => Effect.runPromise(station.stop),
        processEvent: (e: MailboxEvent) => Effect.runPromise(station.processEvent(e)),
        handled,
      }
    })

    expect(promiseRun.decision).toBe(effectRun.decision)
    expect(promiseRun.handled).toEqual(effectRun.handled)
    expect(promiseRun.decision).toBe("ack")
    expect(promiseRun.handled).toEqual(["alpha", "beta"])
  })

  it("error path parity: pipeline ack/nack mapping is identical between APIs", async () => {
    // Force a Store.Transient → both APIs should observe "nack".
    const buildErrorStation = (api: "promise" | "effect") => {
      const store = createReferenceStore()
      const failingStore = {
        ...store,
        commitMessages: async () => ({ ok: false as const, error: { _tag: "Transient" as const, message: "blip" } }),
      }
      const acctP = (async () => {
        const r = await store.createAccount({
          userId: UserId("u"),
          provider: "gmail",
          emailAddress: "x@example.com",
          credentials: {},
          lastEventCursor: null,
          watchExpiresAt: null,
          now: t0,
        })
        if (!r.ok) throw new Error("seed")
        return r.value
      })()
      return acctP.then((acct) => {
        const messages = [synthMessage({ accountId: acct.accountId, messageId: "m" })]
        const provider = buildFakeProvider(acct.accountId, messages)
        if (api === "promise") {
          const station = createStation({
            store: failingStore,
            handler: async () => ok(undefined),
            providers: { fake: provider },
            config: { idlePollIntervalMs: 5, triggerConcurrency: 1, claimBatchSize: 5 },
          })
          return { kind: api, station } as const
        } else {
          return Effect.runPromise(
            createStationEffect({
              store: failingStore,
              handler: async () => ok(undefined),
              providers: { fake: provider },
              config: { idlePollIntervalMs: 5, triggerConcurrency: 1, claimBatchSize: 5 },
            }),
          ).then((station) => ({ kind: api, station }) as const)
        }
      })
    }

    const ev: MailboxEvent = { eventId: "e1", providerPayload: null, receivedAt: t0 }

    const p = await buildErrorStation("promise")
    if (p.kind === "promise") {
      await p.station.start()
      const decision = await p.station.pipeline.processEvent(ev)
      expect(decision).toBe("nack")
      await p.station.stop()
    }

    const e = await buildErrorStation("effect")
    if (e.kind === "effect") {
      await Effect.runPromise(e.station.start)
      const decision = await Effect.runPromise(e.station.processEvent(ev))
      expect(decision).toBe("nack")
      await Effect.runPromise(e.station.stop)
    }
  })
})
