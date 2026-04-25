import type { Notification } from "./types.js"

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/**
 * Decode a Pub/Sub notification payload.
 *
 * Gmail publishes JSON like `{ emailAddress: string, historyId: number | string }`
 * base64-encoded as the Pub/Sub message data. Buffer is provided pre-decoded
 * by the SDK (`message.data` is the raw bytes); we just JSON.parse and
 * validate the shape.
 *
 * `historyId` arrives as a number from Gmail. We coerce to string because
 * the rest of the API expects a string (history.list takes a string).
 */
export const decodeNotification = (data: Buffer | string): { ok: true; value: Notification } | { ok: false; error: string } => {
  let raw: unknown
  try {
    const text = typeof data === "string" ? data : data.toString("utf-8")
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!raw || typeof raw !== "object") return { ok: false, error: "payload is not an object" }
  const obj = raw as Record<string, unknown>
  const email = obj.emailAddress
  const historyId = obj.historyId
  if (!isString(email)) return { ok: false, error: "emailAddress missing or not a string" }
  if (!isString(historyId) && !isNumber(historyId)) {
    return { ok: false, error: "historyId missing or not a string/number" }
  }
  return {
    ok: true,
    value: {
      emailAddress: email.toLowerCase(),
      historyId: String(historyId),
    },
  }
}
