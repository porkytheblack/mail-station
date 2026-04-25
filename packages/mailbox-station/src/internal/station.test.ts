import { describe, expect, it } from "vitest"
import { createReferenceStore, synthMessage } from "mailbox-station-conformance"
import { ok, UserId } from "../index.js"
import type { ProviderFactory, MessageHandlerFn, MailboxEvent, MailMessage } from "./types.js"

const t0 = new Date("2026-01-01T00:00:00Z")

import { createStation } from "./station.js"

describe("station integration: pipeline + worker", () => {
  it("commits messages from a fake provider and runs the handler", async () => {
    const store = createReferenceStore()
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

    const handled: string[] = []
    const handler: MessageHandlerFn = async (m) => {
      handled.push(m.subject)
      return ok(undefined)
    }

    // Build a tiny fake provider whose resolver returns the expected messages
    // and whose runtime is a no-op (we drive the pipeline manually).
    const fakeMessages: ReadonlyArray<MailMessage> = [
      synthMessage({ accountId: acct.value.accountId, messageId: "m1", subject: "alpha" }),
      synthMessage({ accountId: acct.value.accountId, messageId: "m2", subject: "beta" }),
    ]
    const fake: ProviderFactory<{}> = {
      build: () => ({
        api: {},
        resolver: {
          resolve: async () => ok({ accountId: acct.value.accountId, messages: fakeMessages, newCursor: "100" }),
        },
        start: async () => {},
        stop: async () => {},
        wait: async () => {},
      }),
    }

    const station = createStation({
      store,
      handler,
      providers: { fake },
      config: { idlePollIntervalMs: 5, triggerConcurrency: 1, claimBatchSize: 5 },
    })

    await station.start()

    const event: MailboxEvent = { eventId: "e1", providerPayload: null, receivedAt: t0 }
    const decision = await station.pipeline.processEvent(event)
    expect(decision).toBe("ack")

    // Wait for worker to process both jobs.
    const deadline = Date.now() + 2000
    while (handled.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(handled.sort()).toEqual(["alpha", "beta"])

    await station.stop()
  })
})
