import { safeCall, transientStoreError, transientResolverError } from "./shim.js"
import type {
  MailboxEvent,
  MailboxPipeline,
  MessageResolver,
  StationLogger,
  StoreAdapter,
  ResolverError,
  StoreError,
} from "./types.js"

export type PipelineDeps = {
  readonly store: StoreAdapter
  readonly resolver: MessageResolver
  readonly logger: StationLogger
  readonly clock: () => Date
}

/**
 * Build the pipeline: events → resolve → atomic commit → ack/nack decision.
 *
 * Action mapping (per design-spec §8.2):
 *
 *   ResolverError                 → ack/nack    | account state
 *   ──────────────────────────────────────────────────────────
 *   MalformedNotification          ack            none
 *   AccountNotFound                ack            none
 *   AccountPaused                  ack            none
 *   AccountRevoked                 ack            none
 *   CredentialsRevoked             ack            status=revoked
 *   ProviderTransient              nack           none
 *   ProviderPermanent              ack            none
 *
 *   StoreError (during commit)
 *   ──────────────────────────────────────────────────────────
 *   Transient                      nack           none
 *   Permanent                      ack + alarm    none
 *   AccountNotFound                ack            none
 *   DuplicateAccount               ack            none (shouldn't occur on commit)
 */
export const createPipeline = (deps: PipelineDeps): MailboxPipeline => {
  const { store, resolver, logger, clock } = deps

  const handleResolverError = async (
    event: MailboxEvent,
    error: ResolverError,
  ): Promise<"ack" | "nack"> => {
    switch (error._tag) {
      case "MalformedNotification":
        logger.warn("event.dropped", { eventId: event.eventId, reason: "malformed", errorTag: error._tag, details: error.details })
        return "ack"
      case "AccountNotFound":
        logger.info("event.dropped", { eventId: event.eventId, reason: "account_not_found", errorTag: error._tag, emailAddress: error.emailAddress })
        return "ack"
      case "AccountPaused":
        logger.debug("event.dropped", { eventId: event.eventId, reason: "account_paused", errorTag: error._tag, accountId: error.accountId })
        return "ack"
      case "AccountRevoked":
        logger.debug("event.dropped", { eventId: event.eventId, reason: "account_revoked", errorTag: error._tag, accountId: error.accountId })
        return "ack"
      case "CredentialsRevoked": {
        const upd = await safeCall(
          () => store.updateAccount(error.accountId, { status: "revoked", now: clock() }),
          transientStoreError,
        )
        if (!upd.ok) {
          logger.error("account.revoked_persist_failed", { accountId: error.accountId, error: describe(upd.error) })
        } else {
          logger.error("account.revoked", { accountId: error.accountId, reason: error.reason })
        }
        return "ack"
      }
      case "ProviderTransient":
        logger.warn("event.dropped", { eventId: event.eventId, reason: "provider_transient", errorTag: error._tag, message: error.message })
        return "nack"
      case "ProviderPermanent":
        logger.error("event.dropped", { eventId: event.eventId, reason: "provider_permanent", errorTag: error._tag, message: error.message })
        return "ack"
    }
  }

  const handleStoreError = (event: MailboxEvent, error: StoreError): "ack" | "nack" => {
    switch (error._tag) {
      case "Transient":
        logger.warn("event.dropped", { eventId: event.eventId, reason: "store_transient", errorTag: error._tag, message: error.message })
        return "nack"
      case "Permanent":
        // ack to avoid redelivery storm; severe alarm
        logger.error("event.dropped", {
          eventId: event.eventId,
          reason: "store_permanent",
          errorTag: error._tag,
          message: error.message,
          alarm: true,
        })
        return "ack"
      case "AccountNotFound":
        logger.error("event.dropped", { eventId: event.eventId, reason: "store_account_not_found", errorTag: error._tag })
        return "ack"
      case "DuplicateAccount":
        logger.error("event.dropped", { eventId: event.eventId, reason: "store_duplicate", errorTag: error._tag })
        return "ack"
    }
  }

  return {
    processEvent: async (event) => {
      logger.debug("event.received", { eventId: event.eventId })

      const resolved = await safeCall(() => resolver.resolve(event), transientResolverError)
      if (!resolved.ok) {
        return handleResolverError(event, resolved.error)
      }

      const { accountId, messages, newCursor } = resolved.value
      const commit = await safeCall(
        () =>
          store.commitMessages({
            accountId,
            messages,
            newCursor,
            now: clock(),
          }),
        transientStoreError,
      )

      if (!commit.ok) {
        return handleStoreError(event, commit.error)
      }

      logger.info("event.committed", {
        eventId: event.eventId,
        accountId,
        messagesInserted: commit.value.committedMessageIds.length,
        cursorAdvanced: true,
      })
      return "ack"
    },
  }
}

const describe = (e: unknown): string => {
  if (e && typeof e === "object" && "_tag" in e) {
    const tag = (e as { _tag: string })._tag
    const msg = (e as { message?: string }).message ?? ""
    return `${tag}: ${msg}`
  }
  return e instanceof Error ? e.message : String(e)
}
