import type { gmail_v1 } from "@googleapis/gmail"
import addressparser from "addressparser"
import {
  AccountId as makeAccountId,
  MessageId as makeMessageId,
  ThreadId as makeThreadId,
} from "mailbox-station"
import type {
  AccountId,
  AttachmentRef,
  EmailAddress,
  MailMessage,
  MessageId,
  ThreadId,
} from "mailbox-station"

type Part = gmail_v1.Schema$MessagePart

/** Pure: parses a Gmail message into the provider-neutral MailMessage shape. */
export const parseGmailMessage = (
  raw: gmail_v1.Schema$Message,
  accountId: AccountId,
): MailMessage => {
  const headers = collectHeaders(raw.payload?.headers ?? [])

  const { bodyText, bodyHtml, attachments } = walkPayload(raw.payload ?? {})

  const subject = firstHeader(headers, "subject") ?? ""
  const from = parseAddresses(firstHeader(headers, "from") ?? "")[0] ?? { name: null, email: "" }
  const to = parseAddresses(firstHeader(headers, "to") ?? "")
  const cc = parseAddresses(firstHeader(headers, "cc") ?? "")
  const bcc = parseAddresses(firstHeader(headers, "bcc") ?? "")
  const replyTo = parseAddresses(firstHeader(headers, "reply-to") ?? "")
  const sentAt = parseDate(firstHeader(headers, "date"))

  const internalDateMs = numberOrNull(raw.internalDate)
  const receivedAt = internalDateMs !== null ? new Date(internalDateMs) : sentAt ?? new Date(0)

  return {
    messageId: makeMessageId(raw.id ?? ""),
    threadId: raw.threadId ? makeThreadId(raw.threadId) : null,
    accountId,
    provider: "gmail",
    from,
    to,
    cc,
    bcc,
    replyTo,
    subject,
    bodyText,
    bodyHtml,
    headers,
    attachments,
    labels: raw.labelIds ?? [],
    receivedAt,
    sentAt,
    sizeEstimate: raw.sizeEstimate ?? 0,
  }
}

const collectHeaders = (
  headers: ReadonlyArray<gmail_v1.Schema$MessagePartHeader>,
): Record<string, string[]> => {
  const out: Record<string, string[]> = {}
  for (const h of headers) {
    if (!h.name) continue
    const k = h.name.toLowerCase()
    const v = h.value ?? ""
    if (!out[k]) out[k] = []
    out[k].push(v)
  }
  return out
}

const firstHeader = (
  headers: Record<string, string[]>,
  name: string,
): string | undefined => headers[name.toLowerCase()]?.[0]

const parseAddresses = (raw: string): EmailAddress[] => {
  if (!raw) return []
  try {
    const parsed = addressparser(raw)
    return parsed.flatMap((p) => {
      if (p.address) return [{ name: p.name?.length ? p.name : null, email: p.address.toLowerCase() }]
      return []
    })
  } catch {
    return []
  }
}

const parseDate = (raw: string | undefined): Date | null => {
  if (!raw) return null
  const t = Date.parse(raw)
  if (Number.isFinite(t)) return new Date(t)
  return null
}

const numberOrNull = (raw: string | number | null | undefined): number | null => {
  if (raw === null || raw === undefined) return null
  const n = typeof raw === "number" ? raw : Number(raw)
  return Number.isFinite(n) ? n : null
}

type Walked = {
  bodyText: string
  bodyHtml: string
  attachments: AttachmentRef[]
}

const walkPayload = (root: Part): Walked => {
  const out: Walked = { bodyText: "", bodyHtml: "", attachments: [] }
  let foundText = false
  let foundHtml = false

  const visit = (part: Part): void => {
    const mime = (part.mimeType ?? "").toLowerCase()
    const partHeaders = collectHeaders(part.headers ?? [])
    const dispositionRaw = firstHeader(partHeaders, "content-disposition") ?? ""
    const disposition = dispositionRaw.toLowerCase().split(";")[0]?.trim() ?? ""
    const filename = part.filename && part.filename.length > 0 ? part.filename : null
    const cidHeader = firstHeader(partHeaders, "content-id")
    const contentId = stripAngleBrackets(cidHeader)
    const isAttachment =
      disposition === "attachment" ||
      (filename !== null && disposition !== "inline") ||
      (disposition === "inline" && (contentId !== null || filename !== null))

    // message/rfc822 is opaque; do not recurse.
    if (mime === "message/rfc822") {
      const att = makeAttachment(part, partHeaders, filename ?? "rfc822.eml", true)
      if (att) out.attachments.push(att)
      return
    }

    if (mime.startsWith("multipart/")) {
      for (const child of part.parts ?? []) visit(child)
      return
    }

    if (isAttachment) {
      const att = makeAttachment(part, partHeaders, filename ?? "", disposition === "inline")
      if (att) out.attachments.push(att)
      return
    }

    if (mime === "text/plain") {
      if (!foundText) {
        out.bodyText = decodeBase64Url(part.body?.data)
        foundText = true
      }
      return
    }
    if (mime === "text/html") {
      if (!foundHtml) {
        out.bodyHtml = decodeBase64Url(part.body?.data)
        foundHtml = true
      }
      return
    }

    // Unknown leaf type with bytes: treat as attachment if it has an attachmentId.
    if (part.body?.attachmentId) {
      const att = makeAttachment(part, partHeaders, filename ?? "", false)
      if (att) out.attachments.push(att)
    }
  }

  visit(root)
  return out
}

const makeAttachment = (
  part: Part,
  partHeaders: Record<string, string[]>,
  filename: string,
  inline: boolean,
): AttachmentRef | null => {
  const attachmentId = part.body?.attachmentId
  if (!attachmentId) {
    // Inline base64 with no attachment id: still expose, but with empty id.
    if (!filename && (!part.body?.data || part.body.data.length === 0)) return null
  }
  const cidHeader = firstHeader(partHeaders, "content-id")
  return {
    attachmentId: attachmentId ?? "",
    filename,
    mimeType: part.mimeType ?? "application/octet-stream",
    sizeBytes: part.body?.size ?? 0,
    contentId: stripAngleBrackets(cidHeader),
    inline,
  }
}

const stripAngleBrackets = (s: string | undefined | null): string | null => {
  if (!s) return null
  const t = s.trim()
  if (t.startsWith("<") && t.endsWith(">")) return t.slice(1, -1)
  return t
}

const decodeBase64Url = (s: string | undefined | null): string => {
  if (!s) return ""
  try {
    return Buffer.from(s, "base64url").toString("utf-8")
  } catch {
    return ""
  }
}

// Convenience for tests / external use
export const _internals = {
  collectHeaders,
  parseAddresses,
  parseDate,
  decodeBase64Url,
  stripAngleBrackets,
  walkPayload,
  makeAccountId,
}
