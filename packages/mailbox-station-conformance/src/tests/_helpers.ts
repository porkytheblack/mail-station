import { UserId as makeUserId } from "@mail-station/mailbox-station"
import type { MailboxAccount, Provider, StoreAdapter } from "@mail-station/mailbox-station"

export const t0 = new Date("2026-01-01T00:00:00Z")
export const dt = (ms: number): Date => new Date(t0.getTime() + ms)

export const seedAccount = async (
  store: StoreAdapter,
  overrides: {
    provider?: Provider
    email?: string
    userId?: string
    cursor?: string | null
    watchExpiresAt?: Date | null
  } = {},
): Promise<MailboxAccount> => {
  const r = await store.createAccount({
    userId: makeUserId(overrides.userId ?? "user-1"),
    provider: overrides.provider ?? "gmail",
    emailAddress: overrides.email ?? "alice@example.com",
    credentials: { refreshToken: "rt" },
    lastEventCursor: overrides.cursor ?? null,
    watchExpiresAt: overrides.watchExpiresAt ?? null,
    now: t0,
  })
  if (!r.ok) throw new Error(`seedAccount failed: ${JSON.stringify(r.error)}`)
  return r.value
}
