# Trigger worker + backoff

The worker is the second loop in the pipeline (the first is the provider's ingress → resolver → commit). After commit enqueues `pending` jobs, the worker's job is to claim, run the user's handler, and mark done/failed.

## Default config

From `resolveWorkerConfig` (no overrides):

| Field | Default | Notes |
|---|---|---|
| `workerId` | `<host>-<pid>-<rand>` | identifies who holds a lease |
| `triggerConcurrency` | `8` | max in-flight handler invocations |
| `claimBatchSize` | `16` | rows pulled per `claimTriggerJobs` call; **must be ≥ triggerConcurrency** (kernel throws otherwise) |
| `leaseDurationMs` | `300_000` (5 min) | claim expires if not marked done/failed in time |
| `idlePollIntervalMs` | `1_000` | sleep between `claimTriggerJobs` calls when nothing was returned |
| `maxAttempts` | `10` | after this many `Transient` failures, dead-letter |
| `backoff` | see below | retry curve |
| `clock` | `() => new Date()` | inject for tests |
| `random` | `Math.random` | inject for tests |

## Default backoff curve

```ts
defaultBackoff = {
  baseMs: 30_000,        // 30 seconds
  factor: 2,             // exponential
  maxMs: 5 * 60_000,     // capped at 5 minutes
  jitterFactor: 0.25,    // ±25%
}
```

Curve (before jitter): **30s, 1m, 2m, 4m, 5m, 5m, 5m, 5m, 5m, 5m** — total span ~37 min over 10 attempts. After attempt 5 each retry is ~5 minutes (cap).

`nextAttemptDelayMs(attempts, config, random?)` and `computeNextAttemptAt(now, attempts, config, random?)` are exported so tests can compute expected timestamps.

## Tuning examples

### Slower handlers (long-running ingestion)

If the handler takes >5 minutes, raise the lease so the worker doesn't retry mid-flight:

```ts
createStation({
  config: {
    leaseDurationMs: 30 * 60_000,   // 30 min
    triggerConcurrency: 4,           // less parallel work
  },
  // ...
})
```

### Tighter retry for low-latency external API failures

```ts
config: {
  backoff: { baseMs: 5_000, factor: 1.5, maxMs: 60_000, jitterFactor: 0.2 },
  maxAttempts: 6,
}
```

Curve: 5s, 7.5s, ~11s, ~17s, ~25s, ~38s.

### Single-process, no concurrency (debugging)

```ts
config: { triggerConcurrency: 1, claimBatchSize: 1, idlePollIntervalMs: 250 }
```

## Scaling out

Run more processes against the same Store. Lease-based claim semantics give you at-most-one-in-flight per job across the whole fleet — no extra coordination required. Each process picks its own `workerId`, claims independently, and contention is resolved by the row-locking semantics of `claimTriggerJobs` (Postgres `FOR UPDATE SKIP LOCKED`, SQLite `BEGIN IMMEDIATE`).

There's no leader election. Renewal cron is also a separate concern — see `gmail-provider.md`.

## Dead-letter behavior

On the attempt where `attempts === maxAttempts` AND the handler returns `Transient` (or throws), the kernel converts it to terminal: `markTriggerFailed(jobId, message, null, now)`. The job sits in `state='failed'` with `completed_at` set. There's no automatic re-queue.

Operationally, dead-letter rows are kept for observability — the adapter author decides on a pruning policy. To replay: write a script that updates `state='pending'`, `attempts=0`, `next_attempt_at=now`, and clears the lease columns. There's no built-in replay API in v1 (out of scope).

Log event: `trigger.dead_lettered` (alarm-route this).

## Lease expiration

If a worker dies mid-handler, its `lease_expires_at` eventually passes. The next `claimTriggerJobs` call from any worker considers the row claimable again (`lease_expires_at <= :now`). The previous attempt's effects on the user's downstream system (if any) are NOT rolled back — the handler must be idempotent against retries. Make this explicit when reviewing user code.

## Two scheduling responsibilities the user keeps

1. **Watch renewal** — call `station.providers.gmail.renewExpiringWatches()` on a daily-ish cron. The package does NOT bring its own scheduler. See `gmail-provider.md` and `templates/renewal-cron.ts`.
2. **Dead-letter pruning** (optional) — your call whether to keep failed/succeeded rows forever or sweep them.
