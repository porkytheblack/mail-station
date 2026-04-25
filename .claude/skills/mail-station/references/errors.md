# Errors and ack/nack mapping

Every error in the stack is a tagged union. The `_tag` is what drives runtime behavior — what gets logged, whether the upstream Pub/Sub event acks or nacks, whether account state mutates.

## The four error taxonomies

```ts
type StoreError =
  | { _tag: "Transient";       message: string; cause?: unknown }
  | { _tag: "Permanent";       message: string; cause?: unknown }
  | { _tag: "AccountNotFound"; accountId?: AccountId; emailAddress?: string }
  | { _tag: "DuplicateAccount"; provider: Provider; emailAddress: string }

type ResolverError =
  | { _tag: "MalformedNotification";   details: string }
  | { _tag: "AccountNotFound";          emailAddress: string }
  | { _tag: "AccountPaused";            accountId: AccountId }
  | { _tag: "AccountRevoked";           accountId: AccountId }
  | { _tag: "CredentialsRevoked";       accountId: AccountId; reason: string }
  | { _tag: "ProviderTransient";        message: string; statusCode?: number; cause?: unknown }
  | { _tag: "ProviderPermanent";        message: string; statusCode?: number; cause?: unknown }

type IngressError =
  | { _tag: "DecodeError";       message: string }
  | { _tag: "SubscriptionError"; message: string; cause?: unknown }

type HandlerError =
  | { _tag: "Transient";  message: string; cause?: unknown }
  | { _tag: "Permanent";  message: string; cause?: unknown }
```

## Pipeline ack/nack mapping (per design-spec §8.2)

When the resolver returns `err(...)` or `commitMessages` returns `err(...)`, the pipeline maps the tag to one of: **ack** (don't redeliver), **nack** (redeliver), or **state-change-then-ack**:

| Source | Tag | Pub/Sub disposition | Side effect |
|---|---|---|---|
| Resolver | `MalformedNotification` | **ack** | `event.dropped` log; nothing to retry |
| Resolver | `AccountNotFound` | **ack** | log; the account was unregistered |
| Resolver | `AccountPaused` / `AccountRevoked` | **ack** | log; we shouldn't be processing |
| Resolver | `CredentialsRevoked` | **ack** + state change | `updateAccount({ status: "revoked" })`, log `account.revoked` |
| Resolver | `ProviderTransient` | **nack** | redeliver after Pub/Sub backoff |
| Resolver | `ProviderPermanent` | **ack** | unrecoverable upstream — drop |
| Resolver | `HistoryGone` (special) | log + advance cursor | watch lapsed >7d, see `gmail-provider.md` |
| Store on commit | `Transient` / `AccountNotFound` | **nack** | redeliver |
| Store on commit | `Permanent` | **ack** + alarm | high-severity log; broken DB; redelivery would storm |
| Store on commit | `DuplicateAccount` | n/a here | only emitted by `createAccount` |
| Ingress | `DecodeError` | ack the bad message | log `malformed` and move on |
| Ingress | `SubscriptionError` | supervised restart | exponential backoff up to 10 attempts |

**Why `Store.Permanent` acks instead of nacks during commit:** a structurally broken DB will fail every redelivery; nacking creates a hot loop. Acking with an alarm log forces operator intervention. This is a critical operational nuance — surface it to the user when they ask about commit-failure behavior.

## Handler error mapping (per design-spec §6)

When the user's `handler` returns `err({...})`:

| Tag | Worker action |
|---|---|
| `Transient` | `markTriggerFailed(jobId, message, computeNextAttemptAt(...), now)` — retry per backoff |
| `Permanent` | `markTriggerFailed(jobId, message, null, now)` — terminal: `state='failed'`, dead-letter log |

When `attempts` reaches `WorkerConfig.maxAttempts` (default 10) and the latest result was `Transient`, the kernel converts it to terminal: `state='failed'`, log `trigger.dead_lettered`. The user does not need to track attempt count themselves.

**Uncaught throws inside the handler** are caught by the kernel and treated as `Transient` — but this is a backstop. Encourage users to return `err({ _tag: "Transient" | "Permanent", message })` explicitly so the intent is visible in logs.

## Patterns

### Classifying a database error in a Store adapter

```ts
const wrap = async <T>(fn: () => T | Result<T, StoreError>): Promise<Result<T, StoreError>> => {
  try {
    const r = fn()
    if (isResult(r)) return r
    return ok(r as T)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    // Default to Permanent — surfaces the bug. Promote specific errors to Transient
    // (deadlocks, lock wait timeouts, connection resets) only with confidence.
    if (isRetryableDbError(cause)) return err({ _tag: "Transient", message, cause })
    return err({ _tag: "Permanent", message, cause })
  }
}
```

### Classifying a Gmail SDK error in a custom resolver

`gmail-station`'s built-in client already does this; only relevant if writing a fresh resolver:

```ts
if (e.message?.includes("invalid_grant")) return err({ _tag: "CredentialsRevoked", accountId, reason: e.message })
if (status >= 500 || status === 429)     return err({ _tag: "ProviderTransient", message, statusCode: status, cause: e })
if (status >= 400)                        return err({ _tag: "ProviderPermanent", message, statusCode: status, cause: e })
return err({ _tag: "ProviderTransient", message: e.message ?? "unknown", cause: e })
```

### Reading errors out of the handler context

`handler` receives `(message, ctx)` where `ctx = { jobId, accountId, attempt }`. On retry, `ctx.attempt` increments — useful for logging "this is attempt 3 of max 10", but don't use it for the backoff math (the kernel handles that).

## What does NOT exist

- No `onAccountRevoked` / `onWatchExpired` callbacks (out of scope, see `out-of-scope.md`). React to log events instead.
- No retry helpers for transient handler errors — return `err({ _tag: "Transient" })` and the kernel retries.
- No partial-commit recovery — `commitMessages` is atomic; either all three writes land or none do. The resolver doesn't need to handle partial state.
