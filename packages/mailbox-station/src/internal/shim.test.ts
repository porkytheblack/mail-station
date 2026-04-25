import { describe, expect, it } from "vitest"
import { ok, err } from "./result.js"
import { safeCall, transientStoreError } from "./shim.js"

describe("safeCall", () => {
  it("passes through Result on the happy path", async () => {
    const r = await safeCall<string, never>(async () => ok("hi"), transientStoreError as never)
    expect(r).toEqual({ ok: true, value: "hi" })
  })

  it("passes through err Result", async () => {
    const r = await safeCall(async () => err({ _tag: "Permanent", message: "x" }), transientStoreError)
    expect(r.ok).toBe(false)
  })

  it("converts thrown Error into Transient", async () => {
    const r = await safeCall(async () => {
      throw new Error("boom")
    }, transientStoreError)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error._tag).toBe("Transient")
    if (!r.ok) expect(r.error.message).toBe("boom")
  })

  it("converts Result-like throws into Transient", async () => {
    const r = await safeCall(async () => {
      throw { _tag: "Looks-Like-Result" }
    }, transientStoreError)
    expect(r.ok).toBe(false)
  })

  it("converts non-Result return into Transient (defensive)", async () => {
    const r = await safeCall(async () => undefined as any, transientStoreError)
    expect(r.ok).toBe(false)
  })
})
