# mailbox-station

A provider-agnostic core for receiving mailbox events and routing them through a durable commit-then-trigger pipeline. Gmail, Outlook, IMAP, anything that produces "something changed in this mailbox" notifications can plug in.

## Why a separate core

When you have one provider it's tempting to bake everything into `gmail-station`. Two providers later you're either copy-pasting or refactoring under pressure. Splitting the agnostic core out from day one makes each provider package small and disciplined: a provider's job is to produce `MailboxEvent`s and resolve them to `MailMessage`s. Everything downstream — durability, retry, fan-out, observability — lives in `mailbox-station` and is shared.

## Core responsibilities

The package owns the parts of the system that have nothing to do with which mail provider you're talking to:

- **Outbox semantics.** A message is *recognized* (committed durably) before it is *acted on* (triggered). Pub/Sub-style ack happens after commit, not after trigger.
- **Trigger worker.** Claims pending trigger jobs, runs the user's handler, marks done or backs off on failure.
- **Storage abstraction.** A `Store` interface that the user provides an adapter for. The core never imports a database.
- **Handler abstraction.** A `MessageHandler` interface the user provides. Single handler per event type for v1.
- **Errors and types.** Tagged errors, branded IDs, the canonical `MailMessage` shape.

## What it does NOT own

- Talking to any mail provider (no Gmail API calls, no IMAP sockets).
- Authentication and OAuth flows. The provider package handles credentials; the core just persists whatever the provider hands it via the Store.
- Webhook ingress, push subscription handlers, polling loops. Those are provider-specific shapes that emit `MailboxEvent`s into the core's pipeline.
- Watch lifecycle (renewals, expiration recovery). Provider-specific concept; the provider package drives it and uses the Store to persist state.

## The data model

Three nouns the core knows about:

- `MailboxAccount` — a user's mailbox under a specific provider. Carries the provider's credentials blob (opaque to the core), a cursor (`lastEventCursor`) that the provider uses to diff, and lifecycle metadata (subscription expiration if applicable).
- `MailMessage` — a parsed, provider-neutral message. Headers, from/to, subject, body text, body html, attachments-as-references, label/folder list, timestamp. The provider package is responsible for normalizing its native shape into this.
- `TriggerJob` — an outbox entry: "this message needs the handler run on it." Carries attempt count, last error, next-attempt time.

## The pipeline

The contract the core enforces, regardless of provider:

```
provider emits MailboxEvent
  → core resolves event to zero or more MailMessages
      (resolution is delegated to the provider via a MessageResolver interface)
  → core commits atomically:
      insert new messages
    + advance the account cursor
    + enqueue trigger jobs for newly-inserted messages
  → core acks the upstream event
  → trigger worker (separate loop):
      claim pending jobs
    → run handler
    → mark done OR record failure with backoff
```

Two invariants the Store implementation must hold:

1. `commitMessages` is atomic — messages, cursor, and trigger enqueues land together or not at all.
2. `commitMessages` is idempotent on `messageId` — duplicates are skipped, but the cursor still advances. Returned `committedMessageIds` includes only newly-inserted ones, so trigger jobs are only enqueued once.

These two are what make upstream redelivery safe.

## Interfaces the core exposes

- `Store` — pluggable storage. User provides an adapter (sqlite, postgres, redis, an HTTP API, whatever). Methods cover account CRUD, atomic commit, and outbox claim/done/fail.
- `MessageHandler` — the user's trigger logic. Receives `MailMessage` plus context (attempt number, job id). Failure marks the trigger for retry.
- `MessageResolver` — provider-side. "Given this `MailboxEvent` for this account, return the resulting `MailMessage`s and the new cursor value." The provider package implements this.
- `MailboxIngress` — provider-side. Long-running effect that emits `MailboxEvent`s into the pipeline. The provider package implements this (Pub/Sub pull loop, IMAP IDLE, webhook handler, etc.).

## Configuration surface

The core takes:

- A `Store` adapter (required).
- A `MessageHandler` (required).
- Worker tuning: trigger concurrency, idle poll interval, max attempts.

That's it. No provider config in the core.

## Composition

The shape is: the user assembles a runtime by combining `mailbox-station` with one or more provider packages and their own Store adapter. Each provider package brings its own `MailboxIngress` and `MessageResolver` and its own config service. The core wires them into the same outbox.

A multi-provider deployment is straightforward in principle: the same Store, the same handler, two providers. Per-account routing is handled by the provider field on `MailboxAccount`.

## Effect TS specifics

- All async work is `Effect`. No raw promises in the public API.
- Services are `Context.Tag`s. Layers compose them.
- Errors are tagged via `Data.TaggedError` so handlers can `catchTag` precisely.
- The trigger worker and ingress are both `Effect.Effect<never, ...>` long-runners; the user composes them into a top-level `Effect.all` with concurrency unbounded.
- IDs are branded (`UserId`, `MessageId`, etc.) to keep call sites honest.

## Out of scope for v1

- Push delivery handling for any provider. Pull-style ingress only.
- Multi-handler fan-out. One handler per event type; the user's handler can fan out internally if needed.
- Retention policies on stored messages. The Store keeps everything forever unless the adapter implementation prunes.
- Cross-account batching. Each account's events flow independently.
