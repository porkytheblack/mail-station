# mail-station

Provider-agnostic mailbox-watch system. Two published npm packages plus a conformance test battery, all in a single pnpm workspace.

- **`mailbox-station`** — provider-agnostic core: outbox commit, trigger worker, Store interface, handler interface. Promise + `Result` API by default; `/effect` subpath for Effect-TS users.
- **`gmail-station`** — Gmail provider. Wraps `@googleapis/gmail`, OAuth2 refresh, the watch lifecycle, Pub/Sub pull ingress, and a pure MIME parser.
- **`mailbox-station-conformance`** — Vitest-driven test battery (~25 tests) for verifying user-supplied Store implementations against the documented invariants.

The full design lives in [`guides/design-spec.md`](./guides/design-spec.md). The PRD is [issue #1](https://github.com/porkytheblack/mail-station/issues/1).

## Workspace layout

```
mail-station/
├── packages/
│   ├── mailbox-station/                # core
│   ├── gmail-station/                  # Gmail provider
│   └── mailbox-station-conformance/    # store conformance suite
└── examples/
    └── basic-sqlite/                   # runnable smoke + sqlite Store adapter
```

## Develop

```sh
pnpm install
pnpm typecheck     # tsc -b
pnpm test          # vitest across all packages + examples
```

## Quickstart

```ts
import { createStation, ok, UserId } from "mailbox-station"
import { gmailProvider } from "gmail-station"
import { createSqliteStore } from "./sqlite-store.js"

const station = createStation({
  store: createSqliteStore("./mail.db"),
  handler: async (message) => {
    console.log(message.subject, message.from.email)
    return ok(undefined)
  },
  providers: {
    gmail: gmailProvider({
      googleClientId:     process.env.GOOGLE_CLIENT_ID!,
      googleClientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      gcpProjectId:       process.env.GCP_PROJECT_ID!,
      pubsubTopic:        process.env.PUBSUB_TOPIC!,
      pubsubSubscription: process.env.PUBSUB_SUBSCRIPTION!,
    }),
  },
})

await station.start()

await station.providers.gmail.register({
  userId:       UserId("user-1"),
  emailAddress: "alice@example.com",
  refreshToken: "<from your OAuth flow>",
})

process.on("SIGTERM", () => void station.stop())
await station.wait()
```

## What's implemented

- Promise + `Result` API and `/effect` subpath sharing the same kernel.
- 9-method `StoreAdapter` interface with documented invariants (atomic commit, idempotency, lease-based claims).
- Trigger worker with bounded concurrency, configurable backoff (defaults: `30s, 1m, 2m, 4m, 5m, …` capped at 5 min, ~40 min total span, ±25% jitter), max attempts, dead-lettering.
- Tagged-error pipeline with deterministic ack/nack mapping per the design spec §8.2.
- Stable log event names (`account.registered`, `event.committed`, `trigger.dead_lettered`, …) per the public-contract surface.
- Branded IDs (`UserId`, `AccountId`, `MessageId`, `ThreadId`, `JobId`).
- Gmail provider: `users.watch` register + `renewExpiringWatches`, `history.list` pagination + `messages.get` fan-out, MIME parser, Pub/Sub pull ingress with supervised restart, OAuth2 refresh + token writeback.
- Conformance battery covering account lifecycle, atomic+idempotent commit, claim semantics under lease, state transitions. A meta-test runs the suite against an in-memory reference Store to prove both the suite and the reference are correct.
- An example SQLite Store adapter that passes the conformance suite end-to-end.

## Out of scope (v2 punts)

See [`guides/design-spec.md` §14](./guides/design-spec.md#14-out-of-scope-v2-punts).
