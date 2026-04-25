import { Either, Schema } from "effect"
import type { Notification } from "./types.js"

/**
 * Effect Schema for the Gmail Pub/Sub notification payload.
 *
 * Gmail publishes JSON like `{ emailAddress: string, historyId: number | string }`
 * base64-encoded as the message data (the SDK pre-decodes to raw bytes via
 * `message.data`). historyId is a number on the wire; downstream API takes
 * a string. The schema accepts both, normalizes to string, and lowercases
 * the email.
 */
export const NotificationPayloadSchema = Schema.Struct({
  emailAddress: Schema.String.pipe(Schema.minLength(1)),
  historyId: Schema.Union(Schema.String, Schema.Number),
})

export type NotificationPayload = Schema.Schema.Type<typeof NotificationPayloadSchema>

const decodePayload = Schema.decodeUnknownEither(NotificationPayloadSchema, { errors: "all" })

export const decodeNotification = (
  data: Buffer | string,
): { ok: true; value: Notification } | { ok: false; error: string } => {
  let raw: unknown
  try {
    const text = typeof data === "string" ? data : data.toString("utf-8")
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  const decoded = decodePayload(raw)
  if (Either.isLeft(decoded)) {
    return { ok: false, error: decoded.left.message }
  }
  return {
    ok: true,
    value: {
      emailAddress: decoded.right.emailAddress.toLowerCase(),
      historyId: String(decoded.right.historyId),
    },
  }
}
