import { describe, expect, it } from "vitest"
import { decodeNotification } from "./notification.js"

describe("decodeNotification", () => {
  it("decodes a valid payload (number historyId)", () => {
    const r = decodeNotification(
      Buffer.from(JSON.stringify({ emailAddress: "Alice@Example.com", historyId: 1234 }), "utf-8"),
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.emailAddress).toBe("alice@example.com")
      expect(r.value.historyId).toBe("1234")
    }
  })

  it("decodes when historyId is a string", () => {
    const r = decodeNotification(JSON.stringify({ emailAddress: "x@y.z", historyId: "5678" }))
    expect(r.ok && r.value.historyId).toBe("5678")
  })

  it("rejects invalid JSON", () => {
    const r = decodeNotification(Buffer.from("not-json"))
    expect(r.ok).toBe(false)
  })

  it("rejects missing emailAddress", () => {
    const r = decodeNotification(JSON.stringify({ historyId: "1" }))
    expect(r.ok).toBe(false)
  })

  it("rejects missing historyId", () => {
    const r = decodeNotification(JSON.stringify({ emailAddress: "a@b" }))
    expect(r.ok).toBe(false)
  })

  it("rejects non-object payload", () => {
    const r = decodeNotification(JSON.stringify("string"))
    expect(r.ok).toBe(false)
  })
})
