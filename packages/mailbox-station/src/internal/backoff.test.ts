import { describe, expect, it } from "vitest"
import { defaultBackoff, nextAttemptDelayMs, computeNextAttemptAt } from "./backoff.js"

describe("nextAttemptDelayMs", () => {
  it("follows the documented schedule with no jitter (random=0.5 → multiplier 1)", () => {
    const cfg = defaultBackoff
    const r = () => 0.5
    expect(nextAttemptDelayMs(1, cfg, r)).toBe(30_000)
    expect(nextAttemptDelayMs(2, cfg, r)).toBe(60_000)
    expect(nextAttemptDelayMs(3, cfg, r)).toBe(120_000)
    expect(nextAttemptDelayMs(4, cfg, r)).toBe(240_000)
    expect(nextAttemptDelayMs(5, cfg, r)).toBe(300_000)
    expect(nextAttemptDelayMs(6, cfg, r)).toBe(300_000)
    expect(nextAttemptDelayMs(10, cfg, r)).toBe(300_000)
  })

  it("jitter band is ±25% of the capped value", () => {
    const cfg = defaultBackoff
    const lo = nextAttemptDelayMs(1, cfg, () => 0)
    const hi = nextAttemptDelayMs(1, cfg, () => 0.999999)
    expect(lo).toBe(22_500) // 30s * 0.75
    expect(Math.abs(hi - 37_500)).toBeLessThanOrEqual(1) // 30s * 1.25
  })

  it("clamps tiny attempts to 1", () => {
    expect(nextAttemptDelayMs(0, defaultBackoff, () => 0.5)).toBe(30_000)
    expect(nextAttemptDelayMs(-3, defaultBackoff, () => 0.5)).toBe(30_000)
  })

  it("computeNextAttemptAt adds delay to now", () => {
    const now = new Date("2026-01-01T00:00:00Z")
    const next = computeNextAttemptAt(now, 1, defaultBackoff, () => 0.5)
    expect(next.getTime() - now.getTime()).toBe(30_000)
  })
})
