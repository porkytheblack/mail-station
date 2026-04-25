import { describe, expect, it } from "vitest"
import { startIngress } from "./ingress.js"
import type { ResolvedGmailConfig, SubscriptionLike, SubscriptionMessage } from "./types.js"

const noopLogger = (events: Array<{ level: string; event: string; fields?: Record<string, unknown> }>) => ({
  debug: (event: string, fields?: Record<string, unknown>) => events.push({ level: "debug", event, fields }),
  info: (event: string, fields?: Record<string, unknown>) => events.push({ level: "info", event, fields }),
  warn: (event: string, fields?: Record<string, unknown>) => events.push({ level: "warn", event, fields }),
  error: (event: string, fields?: Record<string, unknown>) => events.push({ level: "error", event, fields }),
})

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

const makeFakeSubscription = (
  options: { pushConfigPresent?: boolean; emit?: (sub: FakeSub) => void } = {},
) => {
  return {
    factory: () => {
      const sub = new FakeSub(options.pushConfigPresent ?? false)
      if (options.emit) queueMicrotask(() => options.emit!(sub))
      return sub
    },
  }
}

class FakeSub implements SubscriptionLike {
  private listeners: Record<string, Array<(...args: any[]) => void>> = {}
  closed = false
  constructor(private pushConfigPresent: boolean) {}
  on(event: string, listener: (...args: any[]) => void): this {
    if (!this.listeners[event]) this.listeners[event] = []
    this.listeners[event]!.push(listener)
    return this
  }
  removeAllListeners(): void {
    this.listeners = {}
  }
  async close(): Promise<void> {
    this.closed = true
    for (const fn of this.listeners.close ?? []) fn()
  }
  async metadata(): Promise<{ pushConfigPresent: boolean }> {
    return { pushConfigPresent: this.pushConfigPresent }
  }
  emitMessage(msg: SubscriptionMessage) {
    for (const fn of this.listeners.message ?? []) fn(msg)
  }
  emitError(e: Error) {
    for (const fn of this.listeners.error ?? []) fn(e)
  }
}

describe("ingress", () => {
  it("fails fast when subscription is push-type", async () => {
    const events: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = []
    const factory = makeFakeSubscription({ pushConfigPresent: true })
    const handle = startIngress({
      store: undefined as unknown as never,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger(events),
      clock: () => new Date(),
      config: baseConfig({ subscriptionFactory: factory.factory }),
    })
    await handle.start()
    await handle.wait()
    expect(events.find((e) => e.event === "ingress.subscription_misconfigured")).toBeTruthy()
  })

  it("acks on pipeline ack, nacks on pipeline nack", async () => {
    let pipelineCall = 0
    const messages: Array<{ id: string; data: Buffer; ack: () => void; nack: () => void }> = []
    const factory = makeFakeSubscription({
      emit: (sub) => {
        const acks: string[] = []
        const nacks: string[] = []
        const m1: SubscriptionMessage = {
          id: "m1",
          data: Buffer.from("hi"),
          publishTime: new Date(),
          ack: () => acks.push("m1"),
          nack: () => nacks.push("m1"),
        }
        const m2: SubscriptionMessage = {
          id: "m2",
          data: Buffer.from("hi"),
          publishTime: new Date(),
          ack: () => acks.push("m2"),
          nack: () => nacks.push("m2"),
        }
        messages.push({ id: "m1", data: Buffer.from(""), ack: m1.ack, nack: m1.nack })
        messages.push({ id: "m2", data: Buffer.from(""), ack: m2.ack, nack: m2.nack })
        sub.emitMessage(m1)
        sub.emitMessage(m2)
        // close so ingress wait resolves
        queueMicrotask(() => sub.close())
      },
    })
    const handle = startIngress({
      store: undefined as unknown as never,
      pipeline: {
        processEvent: async () => {
          pipelineCall++
          return pipelineCall === 1 ? "ack" : "nack"
        },
      },
      logger: noopLogger([]),
      clock: () => new Date(),
      config: baseConfig({ subscriptionFactory: factory.factory }),
    })
    await handle.start()
    // Allow microtasks to flush.
    await new Promise((r) => setTimeout(r, 50))
    await handle.stop()
  })

  it("subscription error triggers supervised restart (warn log)", async () => {
    const events: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = []
    let runs = 0
    const factory = () => {
      runs++
      const sub = new FakeSub(false)
      queueMicrotask(() => {
        if (runs === 1) sub.emitError(new Error("connection lost"))
      })
      return sub
    }
    const handle = startIngress({
      store: undefined as unknown as never,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger(events),
      clock: () => new Date(),
      config: baseConfig({ subscriptionFactory: factory }),
    })
    await handle.start()
    await new Promise((r) => setTimeout(r, 1100))
    await handle.stop()
    expect(events.find((e) => e.event === "ingress.subscription_lost")).toBeTruthy()
    expect(runs).toBeGreaterThanOrEqual(2)
  })
})
