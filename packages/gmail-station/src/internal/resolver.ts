import { err, ok } from "mailbox-station"
import type {
  AccountId,
  MailMessage,
  MailboxAccount,
  MailboxEvent,
  MessageResolver,
  ResolveResult,
  ResolverError,
  Result,
  StoreAdapter,
} from "mailbox-station"
import { defaultGmailClientFactory } from "./client.js"
import { decodeNotification } from "./notification.js"
import { parseGmailMessage } from "./parser.js"
import type { GmailClient, GmailCredentials, GmailRuntimeDeps } from "./types.js"

const DEFAULT_FETCH_CONCURRENCY = 8

export const createGmailResolver = (deps: GmailRuntimeDeps): MessageResolver => {
  const { store, logger, clock, config } = deps

  const buildClient = (account: MailboxAccount): GmailClient => {
    const creds = readCredentials(account)
    const factory = config.clientFactory ?? defaultGmailClientFactory
    return factory(creds, {
      config,
      onTokenRefresh: (next) => {
        // Fire-and-forget; the next call refreshes again on writeback failure.
        void store
          .updateAccount(account.accountId, { credentials: { ...account.credentials, ...next }, now: clock() })
          .catch((cause) => {
            logger.warn("oauth.writeback_failed", {
              accountId: account.accountId,
              error: cause instanceof Error ? cause.message : String(cause),
            })
          })
      },
    })
  }

  const resolve = async (event: MailboxEvent): Promise<Result<ResolveResult, ResolverError>> => {
    // 1. Decode payload.
    const decoded = decodeNotification(event.providerPayload as Buffer | string)
    if (!decoded.ok) {
      return err({ _tag: "MalformedNotification", details: decoded.error })
    }
    const { emailAddress, historyId } = decoded.value

    // 2. Look up account.
    const acctR = await store.getAccountByEmail("gmail", emailAddress)
    if (!acctR.ok) {
      if (acctR.error._tag === "AccountNotFound") {
        return err({ _tag: "AccountNotFound", emailAddress })
      }
      return err({ _tag: "ProviderTransient", message: storeErrMessage(acctR.error) })
    }
    const account = acctR.value
    if (account.status === "paused") return err({ _tag: "AccountPaused", accountId: account.accountId })
    if (account.status === "revoked") return err({ _tag: "AccountRevoked", accountId: account.accountId })

    const client = buildClient(account)
    const startCursor = account.lastEventCursor ?? historyId

    // 3. Iterate ALL history.list pages.
    const labelFilter = config.labelFilter
    const singleLabel = labelFilter && labelFilter.length === 1 ? labelFilter[0] : undefined
    const messageIds = new Set<string>()
    let lastHistoryId = startCursor
    let pageToken: string | undefined = undefined

    while (true) {
      const page = await client.historyList({
        startHistoryId: startCursor,
        ...(singleLabel ? { labelId: singleLabel } : {}),
        ...(pageToken ? { pageToken } : {}),
      })
      if (!page.ok) {
        if (page.error._tag === "HistoryGone") {
          // Swallowed inside resolver: advance cursor to notification's historyId, empty messages.
          logger.info("event.history_gone", { accountId: account.accountId, oldCursor: startCursor })
          return ok({ accountId: account.accountId, messages: [], newCursor: historyId })
        }
        if (page.error._tag === "CredentialsRevoked") {
          return err({ _tag: "CredentialsRevoked", accountId: account.accountId, reason: page.error.reason })
        }
        return err(page.error)
      }
      for (const h of page.value.history ?? []) {
        for (const ma of h.messagesAdded ?? []) {
          if (!ma.message?.id) continue
          // Filter at history level when we have multi-label config:
          // labelIds on the history entry's message.
          if (labelFilter && labelFilter.length > 1) {
            const has = (ma.message.labelIds ?? []).some((lid) => labelFilter.includes(lid))
            if (!has) continue
          }
          messageIds.add(ma.message.id)
        }
      }
      if (page.value.historyId) lastHistoryId = String(page.value.historyId)
      pageToken = page.value.nextPageToken ?? undefined
      if (!pageToken) break
    }

    // 4. Fetch messages in parallel with concurrency 8.
    const ids = Array.from(messageIds)
    const fetched: MailMessage[] = []
    const concurrency = config.fetchConcurrency || DEFAULT_FETCH_CONCURRENCY
    const queue = [...ids]
    const workers: Array<Promise<Result<void, ResolverError>>> = []
    let abortError: ResolverError | null = null

    const worker = async (): Promise<Result<void, ResolverError>> => {
      while (queue.length > 0) {
        if (abortError) return err(abortError)
        const id = queue.shift()
        if (!id) return ok(undefined)
        const r = await client.messageGet(id)
        if (!r.ok) {
          if (r.error._tag === "MessageGone") {
            logger.info("message.gone_during_fetch", { messageId: id, accountId: account.accountId })
            continue
          }
          if (r.error._tag === "CredentialsRevoked") {
            abortError = { _tag: "CredentialsRevoked", accountId: account.accountId, reason: r.error.reason }
            return err(abortError)
          }
          abortError = r.error
          return err(abortError)
        }
        fetched.push(parseGmailMessage(r.value, account.accountId))
      }
      return ok(undefined)
    }

    for (let i = 0; i < Math.min(concurrency, queue.length); i++) workers.push(worker())
    const results = await Promise.all(workers)
    for (const wr of results) {
      if (!wr.ok) return err(wr.error)
    }

    // Client-side multi-label filter: history entries already filtered, but
    // messages.get also returns labelIds which we use as a defensive double-check.
    const filtered = labelFilter && labelFilter.length > 0
      ? fetched.filter((m) => m.labels.some((l) => labelFilter.includes(l)))
      : fetched

    return ok({
      accountId: account.accountId,
      messages: filtered,
      newCursor: lastHistoryId,
    })
  }

  return { resolve }
}

const readCredentials = (account: MailboxAccount): GmailCredentials => {
  const c = account.credentials as Record<string, unknown>
  const refreshToken = typeof c.refreshToken === "string" ? c.refreshToken : ""
  const accessToken = typeof c.accessToken === "string" ? c.accessToken : undefined
  const expiresAt = c.accessTokenExpiresAt
  let accessTokenExpiresAt: Date | undefined
  if (expiresAt instanceof Date) accessTokenExpiresAt = expiresAt
  else if (typeof expiresAt === "string" || typeof expiresAt === "number") {
    const t = new Date(expiresAt)
    if (!Number.isNaN(t.getTime())) accessTokenExpiresAt = t
  }
  return { refreshToken, accessToken, accessTokenExpiresAt }
}

const storeErrMessage = (e: import("mailbox-station").StoreError): string => {
  switch (e._tag) {
    case "Transient":
    case "Permanent":
      return e.message
    case "AccountNotFound":
      return `account not found ${e.accountId ?? e.emailAddress ?? ""}`
    case "DuplicateAccount":
      return `duplicate account ${e.emailAddress}`
  }
}

// re-export for tests
export const _resolver_internals = { readCredentials }
