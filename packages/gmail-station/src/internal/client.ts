import { gmail, type gmail_v1 } from "@googleapis/gmail"
import { OAuth2Client } from "google-auth-library"
import { err, ok } from "mailbox-station"
import type { Result, ResolverError } from "mailbox-station"
import type {
  GmailClient,
  GmailClientFactory,
  GmailCredentials,
  ResolvedGmailConfig,
} from "./types.js"

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])
const REQUEST_RETRY_DELAYS_MS = [200, 1_000, 5_000]

type SdkErrorLike = { code?: number | string; status?: number; response?: { status?: number; data?: unknown }; message?: string }

const numericStatus = (e: SdkErrorLike): number | undefined => {
  if (typeof e.code === "number") return e.code
  if (typeof e.code === "string" && /^\d+$/.test(e.code)) return Number(e.code)
  if (typeof e.status === "number") return e.status
  if (e.response?.status) return e.response.status
  return undefined
}

const isInvalidGrant = (e: unknown): boolean => {
  if (!e || typeof e !== "object") return false
  const anyE = e as { message?: unknown; response?: { data?: { error?: unknown } } }
  if (typeof anyE.message === "string" && anyE.message.includes("invalid_grant")) return true
  const errVal = anyE.response?.data?.error
  if (typeof errVal === "string" && errVal === "invalid_grant") return true
  return false
}

const classify = (e: unknown): ResolverError => {
  const sdk = (e ?? {}) as SdkErrorLike
  if (isInvalidGrant(e)) {
    return { _tag: "CredentialsRevoked", accountId: undefined as unknown as never, reason: sdk.message ?? "invalid_grant" }
  }
  const status = numericStatus(sdk)
  const message = sdk.message ?? "gmail request failed"
  if (status && status >= 500) return { _tag: "ProviderTransient", message, statusCode: status, cause: e }
  if (status === 429) return { _tag: "ProviderTransient", message, statusCode: status, cause: e }
  if (status && status >= 400) return { _tag: "ProviderPermanent", message, statusCode: status, cause: e }
  return { _tag: "ProviderTransient", message, cause: e }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Retry a thunk on 5xx/429/network errors up to 3 attempts (200ms, 1s, 5s). */
const retrying = async <T>(thunk: () => Promise<T>): Promise<T> => {
  let lastErr: unknown
  for (let attempt = 0; attempt <= REQUEST_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await thunk()
    } catch (e) {
      lastErr = e
      const sdk = (e ?? {}) as SdkErrorLike
      const status = numericStatus(sdk)
      const retryable = status === undefined || RETRYABLE_STATUS.has(status)
      if (!retryable || attempt === REQUEST_RETRY_DELAYS_MS.length) throw e
      await sleep(REQUEST_RETRY_DELAYS_MS[attempt]!)
    }
  }
  throw lastErr
}

/**
 * Production client factory. Uses `@googleapis/gmail` + `google-auth-library`.
 * Each call constructs a fresh OAuth2Client from the account's credentials,
 * subscribes to the `tokens` event for fire-and-forget writeback, returns
 * a Gmail client.
 */
export const defaultGmailClientFactory: GmailClientFactory = (creds, options): GmailClient => {
  const { config, onTokenRefresh } = options

  const buildAuth = (): OAuth2Client => {
    const auth = new OAuth2Client({
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
    })
    auth.setCredentials({
      refresh_token: creds.refreshToken,
      access_token: creds.accessToken,
      expiry_date: creds.accessTokenExpiresAt?.getTime(),
    })
    auth.on("tokens", (t) => {
      if (!t.access_token) return
      onTokenRefresh({
        refreshToken: creds.refreshToken,
        accessToken: t.access_token,
        accessTokenExpiresAt: t.expiry_date ? new Date(t.expiry_date) : undefined,
      })
    })
    return auth
  }

  const client = (): gmail_v1.Gmail => gmail({ version: "v1", auth: buildAuth() })

  return {
    validateRefreshToken: async () => {
      try {
        const auth = buildAuth()
        // Forces a token refresh through the OAuth2 token endpoint.
        // invalid_grant surfaces as a thrown error here.
        await retrying(() => auth.getAccessToken().then(() => undefined))
        return ok(undefined)
      } catch (e) {
        return err(classify(e))
      }
    },
    watch: async ({ topicName, labelIds }) => {
      try {
        const res = await retrying(() =>
          client().users.watch({
            userId: "me",
            requestBody: {
              topicName,
              ...(labelIds && labelIds.length > 0 ? { labelIds: [...labelIds], labelFilterBehavior: "INCLUDE" } : {}),
            },
          }),
        )
        const historyId = String(res.data.historyId ?? "")
        const expirationMs = Number(res.data.expiration ?? 0)
        if (!historyId) {
          return err({ _tag: "ProviderPermanent", message: "watch returned no historyId" })
        }
        return ok({ historyId, expiration: new Date(expirationMs) })
      } catch (e) {
        return err(classify(e))
      }
    },
    stop: async () => {
      try {
        await retrying(() => client().users.stop({ userId: "me" }))
        return ok(undefined)
      } catch (e) {
        return err(classify(e))
      }
    },
    historyList: async ({ startHistoryId, labelId, pageToken }) => {
      try {
        const res = await retrying(() =>
          client().users.history.list({
            userId: "me",
            startHistoryId,
            historyTypes: ["messageAdded"],
            maxResults: 500,
            ...(labelId ? { labelId } : {}),
            ...(pageToken ? { pageToken } : {}),
          }),
        )
        return ok(res.data)
      } catch (e) {
        const status = numericStatus((e ?? {}) as SdkErrorLike)
        if (status === 404) {
          return err({ _tag: "HistoryGone" } as const)
        }
        return err(classify(e))
      }
    },
    messageGet: async (messageId) => {
      try {
        const res = await retrying(() =>
          client().users.messages.get({ userId: "me", id: messageId, format: "full" }),
        )
        return ok(res.data)
      } catch (e) {
        const status = numericStatus((e ?? {}) as SdkErrorLike)
        if (status === 404) {
          return err({ _tag: "MessageGone" } as const)
        }
        return err(classify(e))
      }
    },
  }
}

export const _client_internals = { classify, isInvalidGrant, RETRYABLE_STATUS }
