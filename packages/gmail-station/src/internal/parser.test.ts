import { describe, expect, it } from "vitest"
import { AccountId as makeAccountId } from "@mail-station/mailbox-station"
import type { gmail_v1 } from "@googleapis/gmail"
import { _internals, parseGmailMessage } from "./parser.js"

const accountId = makeAccountId("acc-1")

const b64 = (s: string): string => Buffer.from(s, "utf-8").toString("base64url")

const makeRaw = (overrides: Partial<gmail_v1.Schema$Message> = {}): gmail_v1.Schema$Message => ({
  id: "m1",
  threadId: "t1",
  labelIds: ["INBOX"],
  internalDate: "1735689600000", // 2025-01-01
  sizeEstimate: 1234,
  ...overrides,
})

describe("parseGmailMessage", () => {
  it("parses a single text/plain message", () => {
    const m = parseGmailMessage(
      makeRaw({
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "Alice <alice@example.com>" },
            { name: "To", value: "Bob <bob@example.com>" },
            { name: "Subject", value: "Hello" },
            { name: "Date", value: "Wed, 01 Jan 2025 12:00:00 +0000" },
          ],
          body: { data: b64("Hello there") },
        },
      }),
      accountId,
    )

    expect(m.subject).toBe("Hello")
    expect(m.from).toEqual({ name: "Alice", email: "alice@example.com" })
    expect(m.to).toEqual([{ name: "Bob", email: "bob@example.com" }])
    expect(m.bodyText).toBe("Hello there")
    expect(m.bodyHtml).toBe("")
    expect(m.attachments).toEqual([])
    expect(m.labels).toEqual(["INBOX"])
    expect(m.messageId).toBe("m1")
    expect(m.threadId).toBe("t1")
    expect(m.sizeEstimate).toBe(1234)
  })

  it("multipart/alternative picks first text/plain and first text/html", () => {
    const m = parseGmailMessage(
      makeRaw({
        payload: {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64("plain v1") } },
            { mimeType: "text/plain", body: { data: b64("plain v2") } },
            { mimeType: "text/html", body: { data: b64("<p>v1</p>") } },
            { mimeType: "text/html", body: { data: b64("<p>v2</p>") } },
          ],
        },
      }),
      accountId,
    )
    expect(m.bodyText).toBe("plain v1")
    expect(m.bodyHtml).toBe("<p>v1</p>")
  })

  it("multipart/mixed extracts attachment with disposition: attachment", () => {
    const m = parseGmailMessage(
      makeRaw({
        payload: {
          mimeType: "multipart/mixed",
          parts: [
            { mimeType: "text/plain", body: { data: b64("body") } },
            {
              mimeType: "application/pdf",
              filename: "doc.pdf",
              headers: [{ name: "Content-Disposition", value: "attachment; filename=doc.pdf" }],
              body: { attachmentId: "ATT-1", size: 4096 },
            },
          ],
        },
      }),
      accountId,
    )
    expect(m.bodyText).toBe("body")
    expect(m.attachments).toHaveLength(1)
    expect(m.attachments[0]).toMatchObject({
      attachmentId: "ATT-1",
      filename: "doc.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4096,
      inline: false,
    })
  })

  it("multipart/related inline image with Content-ID becomes attachment with inline=true", () => {
    const m = parseGmailMessage(
      makeRaw({
        payload: {
          mimeType: "multipart/related",
          parts: [
            { mimeType: "text/html", body: { data: b64("<img src=cid:abc>") } },
            {
              mimeType: "image/png",
              filename: "logo.png",
              headers: [
                { name: "Content-Disposition", value: "inline; filename=logo.png" },
                { name: "Content-ID", value: "<abc>" },
              ],
              body: { attachmentId: "ATT-2", size: 100 },
            },
          ],
        },
      }),
      accountId,
    )
    expect(m.bodyHtml).toBe("<img src=cid:abc>")
    expect(m.attachments).toHaveLength(1)
    expect(m.attachments[0]).toMatchObject({
      filename: "logo.png",
      contentId: "abc",
      inline: true,
    })
  })

  it("html-only message", () => {
    const m = parseGmailMessage(
      makeRaw({
        payload: {
          mimeType: "text/html",
          body: { data: b64("<p>hi</p>") },
        },
      }),
      accountId,
    )
    expect(m.bodyText).toBe("")
    expect(m.bodyHtml).toBe("<p>hi</p>")
  })

  it("message with no body produces empty strings, never throws", () => {
    const m = parseGmailMessage(makeRaw({ payload: { mimeType: "text/plain" } }), accountId)
    expect(m.bodyText).toBe("")
    expect(m.bodyHtml).toBe("")
  })

  it("message with no headers tolerated", () => {
    const m = parseGmailMessage(makeRaw({ payload: {} }), accountId)
    expect(m.subject).toBe("")
    expect(m.from).toEqual({ name: null, email: "" })
  })

  it("base64url decodes correctly with URL-safe chars", () => {
    const data = "hello world+/=?"
    const m = parseGmailMessage(
      makeRaw({ payload: { mimeType: "text/plain", body: { data: b64(data) } } }),
      accountId,
    )
    expect(m.bodyText).toBe(data)
  })

  it("display-name + email parsing for from/to/cc", () => {
    const m = parseGmailMessage(
      makeRaw({
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: '"Alice Smith" <alice@example.com>' },
            { name: "To", value: "bob@example.com, Carol <carol@example.com>" },
            { name: "Cc", value: "Dave <DAVE@example.com>" },
          ],
        },
      }),
      accountId,
    )
    expect(m.from).toEqual({ name: "Alice Smith", email: "alice@example.com" })
    expect(m.to).toEqual([
      { name: null, email: "bob@example.com" },
      { name: "Carol", email: "carol@example.com" },
    ])
    // emails normalized to lowercase
    expect(m.cc[0]?.email).toBe("dave@example.com")
  })

  it("missing Date header → sentAt=null, receivedAt from internalDate", () => {
    const m = parseGmailMessage(makeRaw({ payload: { mimeType: "text/plain" } }), accountId)
    expect(m.sentAt).toBeNull()
    expect(m.receivedAt.getTime()).toBe(1735689600000)
  })

  it("malformed Date header → sentAt=null", () => {
    const m = parseGmailMessage(
      makeRaw({
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "Date", value: "not-a-date" }],
        },
      }),
      accountId,
    )
    expect(m.sentAt).toBeNull()
  })

  it("Content-ID with and without angle brackets", () => {
    expect(_internals.stripAngleBrackets("<abc>")).toBe("abc")
    expect(_internals.stripAngleBrackets("abc")).toBe("abc")
    expect(_internals.stripAngleBrackets(undefined)).toBeNull()
  })

  it("message/rfc822 forwarded part is NOT recursed and is treated as opaque attachment", () => {
    const m = parseGmailMessage(
      makeRaw({
        payload: {
          mimeType: "multipart/mixed",
          parts: [
            { mimeType: "text/plain", body: { data: b64("body") } },
            {
              mimeType: "message/rfc822",
              filename: "fwd.eml",
              body: { attachmentId: "ATT-FWD", size: 200 },
              parts: [
                { mimeType: "text/plain", body: { data: b64("inner") } },
              ],
            },
          ],
        },
      }),
      accountId,
    )
    // Inner part NOT picked up
    expect(m.bodyText).toBe("body")
    expect(m.attachments).toHaveLength(1)
    expect(m.attachments[0]?.mimeType).toBe("message/rfc822")
  })

  it("multi-value headers preserved as arrays with lowercased keys", () => {
    const m = parseGmailMessage(
      makeRaw({
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "Received", value: "from a" },
            { name: "Received", value: "from b" },
            { name: "Authentication-Results", value: "pass" },
          ],
        },
      }),
      accountId,
    )
    expect(m.headers["received"]).toEqual(["from a", "from b"])
    expect(m.headers["authentication-results"]).toEqual(["pass"])
  })

  it("filename present without explicit disposition is still treated as attachment", () => {
    const m = parseGmailMessage(
      makeRaw({
        payload: {
          mimeType: "multipart/mixed",
          parts: [
            { mimeType: "text/plain", body: { data: b64("body") } },
            {
              mimeType: "application/octet-stream",
              filename: "data.bin",
              body: { attachmentId: "ATT-X", size: 8 },
            },
          ],
        },
      }),
      accountId,
    )
    expect(m.attachments).toHaveLength(1)
    expect(m.attachments[0]?.filename).toBe("data.bin")
  })
})
