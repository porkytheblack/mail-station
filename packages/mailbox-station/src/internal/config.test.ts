import { describe, expect, it } from "vitest"
import { resolveWorkerConfig } from "./config.js"

describe("resolveWorkerConfig", () => {
  it("applies all spec defaults", () => {
    const c = resolveWorkerConfig(undefined)
    expect(c.triggerConcurrency).toBe(8)
    expect(c.claimBatchSize).toBe(16)
    expect(c.leaseDurationMs).toBe(5 * 60_000)
    expect(c.idlePollIntervalMs).toBe(1_000)
    expect(c.maxAttempts).toBe(10)
    expect(c.backoff.baseMs).toBe(30_000)
    expect(c.backoff.factor).toBe(2)
    expect(c.backoff.maxMs).toBe(5 * 60_000)
    expect(c.backoff.jitterFactor).toBe(0.25)
    expect(c.workerId).toMatch(/-/)
  })

  it("rejects claimBatchSize < triggerConcurrency", () => {
    expect(() => resolveWorkerConfig({ triggerConcurrency: 8, claimBatchSize: 4 })).toThrow(
      /claimBatchSize \(4\) must be >= triggerConcurrency \(8\)/,
    )
  })

  it("rejects triggerConcurrency < 1", () => {
    expect(() => resolveWorkerConfig({ triggerConcurrency: 0 })).toThrow(/triggerConcurrency must be >= 1/)
  })

  it("allows claimBatchSize == triggerConcurrency (equal is ok per the guard)", () => {
    // Spec §7.4 prefers strictly greater for slack, but the guard treats
    // equal as acceptable since the loop doesn't deadlock at equality.
    const c = resolveWorkerConfig({ triggerConcurrency: 4, claimBatchSize: 4 })
    expect(c.triggerConcurrency).toBe(4)
    expect(c.claimBatchSize).toBe(4)
  })
})
