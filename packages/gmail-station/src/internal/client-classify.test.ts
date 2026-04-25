import { describe, expect, it } from "vitest"
import { _client_internals } from "./client.js"

const { classify, isInvalidGrant } = _client_internals

describe("client.classify", () => {
  it("invalid_grant message → CredentialsRevoked", () => {
    const e = { message: "invalid_grant: token revoked" }
    expect(isInvalidGrant(e)).toBe(true)
    expect(classify(e)._tag).toBe("CredentialsRevoked")
  })

  it("invalid_grant in response.data.error → CredentialsRevoked", () => {
    const e = { response: { data: { error: "invalid_grant" } } }
    expect(isInvalidGrant(e)).toBe(true)
    expect(classify(e)._tag).toBe("CredentialsRevoked")
  })

  it("5xx → ProviderTransient", () => {
    expect(classify({ code: 503, message: "down" })._tag).toBe("ProviderTransient")
    expect(classify({ status: 502, message: "bad gateway" })._tag).toBe("ProviderTransient")
  })

  it("429 → ProviderTransient (rate limit)", () => {
    expect(classify({ code: 429, message: "too many" })._tag).toBe("ProviderTransient")
  })

  it("4xx → ProviderPermanent", () => {
    expect(classify({ code: 401, message: "unauth" })._tag).toBe("ProviderPermanent")
    expect(classify({ code: 403, message: "forbidden" })._tag).toBe("ProviderPermanent")
  })

  it("network error (no status) → ProviderTransient", () => {
    expect(classify({ message: "ECONNRESET" })._tag).toBe("ProviderTransient")
  })
})
