import {
  AccountId as makeAccountId,
  MessageId as makeMessageId,
  ThreadId as makeThreadId,
  UserId as makeUserId,
} from "mailbox-station"
import type { AccountId, MailMessage, MessageId } from "mailbox-station"

export const synthMessage = (
  overrides: Omit<Partial<MailMessage>, "messageId" | "threadId"> & {
    accountId: AccountId
    messageId: string
    threadId?: string | null
    receivedAt?: Date
  },
): MailMessage => ({
  messageId: makeMessageId(overrides.messageId),
  threadId:
    overrides.threadId === null
      ? null
      : makeThreadId(overrides.threadId ?? "t-" + overrides.messageId),
  accountId: overrides.accountId,
  provider: "gmail",
  from: { name: null, email: "from@example.com" },
  to: [{ name: null, email: "to@example.com" }],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: overrides.subject ?? "subject",
  bodyText: overrides.bodyText ?? "body",
  bodyHtml: overrides.bodyHtml ?? "",
  headers: overrides.headers ?? {},
  attachments: overrides.attachments ?? [],
  labels: overrides.labels ?? [],
  receivedAt: overrides.receivedAt ?? new Date("2026-01-01T00:00:00Z"),
  sentAt: overrides.sentAt ?? null,
  sizeEstimate: overrides.sizeEstimate ?? 100,
})

export const aUserId = (s = "user-1") => makeUserId(s)
export const aMessageId = (s: string): MessageId => makeMessageId(s)
export const anAccountId = (): AccountId => makeAccountId(crypto.randomUUID())
