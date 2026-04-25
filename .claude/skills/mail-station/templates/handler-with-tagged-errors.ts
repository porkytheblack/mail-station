// Handler that returns Result<void, HandlerError> with the right tags.
// Tags drive runtime behavior:
//   { _tag: "Transient", message } -> retry per backoff (up to maxAttempts, then dead-letter)
//   { _tag: "Permanent", message } -> dead-letter immediately
//
// Uncaught throws are caught by the kernel and treated as Transient (backstop),
// but you should classify yourself so the intent shows up in logs.

import { err, ok } from "mailbox-station"
import type { MailMessage, HandlerContext, HandlerError, Result } from "mailbox-station"

// Replace these with your real downstream calls.
declare const indexInSearchEngine: (m: MailMessage) => Promise<void>
declare const enrichWithEnrichmentApi: (email: string) => Promise<{ enriched: true } | null>
declare const isQuotaError: (e: unknown) => boolean
declare const isAuthError:  (e: unknown) => boolean

export const handler = async (
  message: MailMessage,
  ctx:     HandlerContext,
): Promise<Result<void, HandlerError>> => {
  // Idempotency note: handlers are invoked at-least-once. If you write to a
  // downstream system, key on `(accountId, messageId)` so retries are safe.

  // ---- step 1: external API call that may rate-limit ----
  let enriched: { enriched: true } | null
  try {
    enriched = await enrichWithEnrichmentApi(message.from.email)
  } catch (e: unknown) {
    if (isQuotaError(e)) {
      // 429 / rate-limit / quota-exceeded → backoff and retry
      const m = e instanceof Error ? e.message : "rate limited"
      return err<HandlerError>({ _tag: "Transient", message: `enrichment quota: ${m}`, cause: e })
    }
    if (isAuthError(e)) {
      // 401/403 → don't loop forever; the operator must rotate credentials
      const m = e instanceof Error ? e.message : "auth failed"
      return err<HandlerError>({ _tag: "Permanent", message: `enrichment auth: ${m}`, cause: e })
    }
    // Default unknown failure to Transient. Promote to Permanent only with confidence.
    const m = e instanceof Error ? e.message : "unknown"
    return err<HandlerError>({ _tag: "Transient", message: `enrichment: ${m}`, cause: e })
  }

  // ---- step 2: business validation that's deterministic ----
  if (!enriched) {
    // The enrichment API said "no record" — this is data, not a transient failure.
    // Returning Permanent skips retries; if you'd rather succeed silently, return ok().
    return err<HandlerError>({ _tag: "Permanent", message: "no enrichment record" })
  }

  // ---- step 3: persistent write with retry-on-blip semantics ----
  try {
    await indexInSearchEngine(message)
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : "unknown"
    return err<HandlerError>({ _tag: "Transient", message: `index: ${m}`, cause: e })
  }

  return ok(undefined)
}

// HandlerContext fields you can read:
//   ctx.jobId     — branded JobId; useful for log correlation
//   ctx.accountId — branded AccountId; same
//   ctx.attempt   — 1-based attempt counter (1 on first try, increments on retries)
//
// Don't use ctx.attempt for the backoff math — the kernel handles that. Use it
// for "this is attempt 3 of max 10" log lines if you want operator visibility.
