import { err, ok } from "@mail-station/mailbox-station"
import type { AccountId, MailboxAccount, Result } from "@mail-station/mailbox-station"
import { defaultGmailClientFactory } from "./client.js"
import type {
  GmailClient,
  GmailRuntimeDeps,
  RegisterError,
  RenewSummary,
} from "./types.js"

const RENEW_CONCURRENCY = 8

export const createWatchManager = (deps: GmailRuntimeDeps) => {
  const { store, logger, clock, config } = deps

  const buildClient = (refreshToken: string, account?: MailboxAccount): GmailClient => {
    const factory = config.clientFactory ?? defaultGmailClientFactory
    return factory(
      { refreshToken },
      {
        config,
        onTokenRefresh: (next) => {
          if (!account) return
          void store
            .updateAccount(account.accountId, { credentials: { ...account.credentials, ...next }, now: clock() })
            .catch(() => {})
        },
      },
    )
  }

  const register = async (input: {
    userId: import("@mail-station/mailbox-station").UserIdType
    emailAddress: string
    refreshToken: string
  }): Promise<Result<{ accountId: AccountId }, RegisterError>> => {
    const email = input.emailAddress.toLowerCase()

    // 1. Pre-flight duplicate check.
    const existing = await store.getAccountByEmail("gmail", email)
    if (existing.ok) {
      return err({ _tag: "DuplicateAccount", emailAddress: email })
    } else if (existing.error._tag !== "AccountNotFound") {
      const msg =
        existing.error._tag === "Transient" || existing.error._tag === "Permanent"
          ? existing.error.message
          : `duplicate account ${"emailAddress" in existing.error ? existing.error.emailAddress : ""}`
      return err({ _tag: "ProviderTransient", message: msg })
    }

    // 2. Validate refresh token + start watch in one shot. The watch call
    //    triggers a token-endpoint refresh, so invalid_grant surfaces here.
    const client = buildClient(input.refreshToken)
    const watch = await client.watch({
      topicName: config.pubsubTopic,
      ...(config.labelFilter ? { labelIds: [...config.labelFilter] } : {}),
    })
    if (!watch.ok) {
      if (watch.error._tag === "CredentialsRevoked") {
        return err({ _tag: "InvalidGrant", reason: watch.error.reason })
      }
      if (watch.error._tag === "ProviderTransient") {
        return err({ _tag: "ProviderTransient", message: watch.error.message, cause: watch.error.cause })
      }
      const errMsg = "message" in watch.error ? (watch.error as { message?: string }).message : undefined
      return err({
        _tag: "ProviderPermanent",
        message: errMsg ?? watch.error._tag,
        cause: watch.error,
      })
    }

    // 3. Persist via createAccount.
    const created = await store.createAccount({
      userId: input.userId,
      provider: "gmail",
      emailAddress: email,
      credentials: { refreshToken: input.refreshToken },
      lastEventCursor: watch.value.historyId,
      watchExpiresAt: watch.value.expiration,
      now: clock(),
    })

    if (!created.ok) {
      // Compensate: best-effort users.stop. 7-day expiration backstops anyway.
      const stop = await client.stop()
      if (!stop.ok) {
        logger.warn("watch.compensating_stop_failed", {
          emailAddress: email,
          error: stop.error._tag,
        })
      }
      if (created.error._tag === "DuplicateAccount") {
        return err({ _tag: "DuplicateAccount", emailAddress: email })
      }
      return err({ _tag: "StoreError", message: created.error._tag })
    }

    logger.info("account.registered", {
      accountId: created.value.accountId,
      provider: "gmail",
      emailAddress: email,
    })
    return ok({ accountId: created.value.accountId })
  }

  const renewExpiringWatches = async (): Promise<Result<RenewSummary, never>> => {
    const cutoff = new Date(clock().getTime() + config.renewalWindowMs)
    const list = await store.listAccountsExpiringWatch("gmail", cutoff)
    if (!list.ok) {
      logger.warn("watch.renew_list_failed", { error: list.error._tag })
      return ok({ renewed: 0, failed: 0, revoked: 0, details: [] })
    }

    const summary: {
      renewed: number
      failed: number
      revoked: number
      details: Array<{ accountId: AccountId; emailAddress: string; outcome: "renewed" | "failed" | "revoked"; error?: string }>
    } = { renewed: 0, failed: 0, revoked: 0, details: [] }

    const queue = [...list.value]
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const account = queue.shift()
        if (!account) return
        const refreshToken = (account.credentials as { refreshToken?: string }).refreshToken ?? ""
        const client = buildClient(refreshToken, account)
        const watch = await client.watch({
          topicName: config.pubsubTopic,
          ...(config.labelFilter ? { labelIds: [...config.labelFilter] } : {}),
        })
        const oldExpiry = account.watchExpiresAt
        if (!watch.ok) {
          if (watch.error._tag === "CredentialsRevoked") {
            await store.updateAccount(account.accountId, { status: "revoked", now: clock() })
            logger.error("account.revoked", { accountId: account.accountId, reason: watch.error.reason })
            summary.revoked += 1
            summary.details.push({
              accountId: account.accountId,
              emailAddress: account.emailAddress,
              outcome: "revoked",
              error: watch.error.reason,
            })
            continue
          }
          summary.failed += 1
          summary.details.push({
            accountId: account.accountId,
            emailAddress: account.emailAddress,
            outcome: "failed",
            error: "_tag" in watch.error ? watch.error._tag : "unknown",
          })
          continue
        }
        const upd = await store.updateAccount(account.accountId, {
          lastEventCursor: watch.value.historyId,
          watchExpiresAt: watch.value.expiration,
          now: clock(),
        })
        if (!upd.ok) {
          summary.failed += 1
          summary.details.push({
            accountId: account.accountId,
            emailAddress: account.emailAddress,
            outcome: "failed",
            error: upd.error._tag,
          })
          continue
        }
        summary.renewed += 1
        summary.details.push({
          accountId: account.accountId,
          emailAddress: account.emailAddress,
          outcome: "renewed",
        })
        logger.info("account.watch_renewed", {
          accountId: account.accountId,
          oldExpiry,
          newExpiry: watch.value.expiration,
        })
      }
    }

    const workers: Array<Promise<void>> = []
    for (let i = 0; i < Math.min(RENEW_CONCURRENCY, queue.length); i++) workers.push(worker())
    await Promise.all(workers)
    return ok(summary)
  }

  return { register, renewExpiringWatches }
}
