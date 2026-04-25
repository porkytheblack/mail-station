# Log events

Stable log event names are part of the public contract (design-spec §16). They will not be renamed without a major version bump. Wire dashboards, alerts, and SLO definitions against these names.

## Account lifecycle

| Event | Level | When |
|---|---|---|
| `account.registered` | info | After successful `register` (Store insert + `users.watch` succeeded) |
| `account.watch_renewed` | info | After successful `users.watch` re-call during `renewExpiringWatches` |
| `account.revoked` | warn | Resolver got `CredentialsRevoked`; account moved to `status="revoked"` |
| `account.revoked_persist_failed` | error | The revoke transition couldn't be written to the Store (alarm) |

## Pipeline / event ingress

| Event | Level | When |
|---|---|---|
| `event.received` | debug | Pub/Sub message decoded into a `MailboxEvent` |
| `event.committed` | info | Atomic commit succeeded (`messagesInserted` field on log entry) |
| `event.dropped` | warn | Pipeline acked an event without committing (resolver returned a deterministic error) |
| `event.history_gone` | warn | Watch lapsed past 7 days; cursor advanced to recover |

## Trigger worker

| Event | Level | When |
|---|---|---|
| `trigger.claimed` | debug | A pending job was claimed by this worker |
| `trigger.succeeded` | info | Handler returned `ok(undefined)`, marked done |
| `trigger.failed` | warn | Handler returned `err(...)`, will retry |
| `trigger.dead_lettered` | error | `attempts === maxAttempts` and last result was Transient — terminal failure (alarm) |
| `trigger.claim_failed` | error | `claimTriggerJobs` returned an error (Store-level) |
| `trigger.done_persist_failed` | error | `markTriggerDone` failed (alarm — handler succeeded but state didn't advance) |
| `trigger.fail_persist_failed` | error | `markTriggerFailed` failed (alarm — same severity) |
| `trigger.unexpected_error` | error | Uncaught throw inside the worker loop |

## Gmail provider — ingress + watch

| Event | Level | When |
|---|---|---|
| `ingress.started` | info | Pub/Sub subscription is open |
| `ingress.subscription_lost` | warn | Subscription emitted `error`; will restart with backoff |
| `ingress.restarting` | info | Restarting the subscription after a backoff |
| `ingress.giving_up` | error | Restart attempts exhausted (10); operator must intervene (alarm) |
| `ingress.handler_threw` | error | Pub/Sub message handler threw; nack'd |
| `ingress.subscription_metadata_failed` | warn | Couldn't fetch subscription metadata at start (non-fatal) |
| `ingress.subscription_misconfigured` | error | Subscription is push-type, not pull (config bug; will not start) |
| `watch.renew_list_failed` | error | `listAccountsExpiringWatch` failed during renewal cron |
| `watch.compensating_stop_failed` | warn | After register-side compensation, a `users.stop` cleanup call failed |

## Gmail provider — message resolution

| Event | Level | When |
|---|---|---|
| `message.gone_during_fetch` | debug | `messages.get` returned 404 (deleted between history.list and fetch); skipped |
| `oauth.writeback_failed` | warn | Refresh-token writeback to Store failed (best-effort; next call refreshes again) |

## Worker process-level

| Event | Level | When |
|---|---|---|
| `worker.crashed` | error | The worker loop itself crashed (alarm) |

## What to alarm on

Bare minimum:

- `trigger.dead_lettered` — handler-level data loss
- `trigger.done_persist_failed` / `trigger.fail_persist_failed` — Store-level data loss
- `account.revoked_persist_failed` — state transition lost
- `ingress.giving_up` — pipeline is offline
- `ingress.subscription_misconfigured` — pipeline failed to start
- `worker.crashed` — pipeline silently dead

The `*_persist_failed` events are "the user's storage is broken" signals; treat as P1.

## What's intentionally NOT logged

- Per-message handler invocation start (would be one log per message — too noisy; use `trigger.claimed` if you really want this signal)
- Successful OAuth refreshes (only failures via `oauth.writeback_failed`)
- Pub/Sub ack/nack at every step (the disposition is implied by `event.committed` vs `event.dropped`)
