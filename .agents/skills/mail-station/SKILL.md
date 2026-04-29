---
name: mail-station
description: Use when integrating the npm packages `mailbox-station` (provider-agnostic mailbox-watch core) or `gmail-station` (Gmail provider). Triggers for: wiring up `createStation`, writing or porting a `StoreAdapter`, building a `MessageHandlerFn`, configuring the Gmail provider (OAuth, Pub/Sub, watch lifecycle), tuning the trigger worker (concurrency, backoff, dead-letter), interpreting tagged errors, scheduling watch renewal, or any question of the form "how do I do X with mail-station / gmail-station". Do NOT trigger for: generic email parsing libraries, raw Gmail API usage outside this stack, IMAP, or sending mail.
---

# mail-station skill

Authoritative help for consumers of [`mailbox-station`](https://www.npmjs.com/package/mailbox-station) and [`gmail-station`](https://www.npmjs.com/package/gmail-station). Keeps the user inside the stack's public contract — does not invent API surface, does not contradict the design spec.

## How this skill is laid out

This skill uses progressive disclosure. `SKILL.md` (this file) covers the model and how to triage requests. Load a reference file only when the user's question lives there:

- `references/api-surface.md` — every exported symbol from both packages, with real signatures
- `references/store-contract.md` — the 9-method `StoreAdapter`, invariants, atomic-commit pattern
- `references/errors.md` — tagged-error unions, ack/nack mapping, what state changes per tag
- `references/worker-and-backoff.md` — concurrency knobs, default backoff curve, dead-lettering
- `references/gmail-provider.md` — `GmailConfig`, register flow, Pub/Sub auth, watch renewal
- `references/log-events.md` — every stable log event name
- `references/out-of-scope.md` — v1 punts; what to politely refuse

And ready-to-paste boilerplate in `templates/`:

- `templates/wire-station.ts` — minimal `createStation` setup
- `templates/postgres-store.ts` — skeleton `StoreAdapter` for Postgres with invariant comments
- `templates/renewal-cron.ts` — daily watch renewal scheduling
- `templates/handler-with-tagged-errors.ts` — handler returning `Transient`/`Permanent` correctly

## Core mental model (always have this loaded)

Two packages, one workspace:

- **`mailbox-station`** is the provider-agnostic core. It owns the `StoreAdapter` interface, the trigger worker, the `createStation` factory, and the `Result<T,E>` API. It knows nothing about Gmail.
- **`gmail-station`** is a provider plugin. It supplies a `MessageResolver` (Gmail history.list + messages.get + MIME parse), a Pub/Sub pull ingress, a watch-lifecycle manager, and an OAuth2 refresh client.

Pipeline shape (provider-agnostic):

```
provider ingress receives MailboxEvent
  → core resolves event via the provider's MessageResolver
  → core commits atomically (insert messages + cursor + enqueue trigger jobs)
  → core acks the upstream event
  → trigger worker (separate loop): claim → handler → markDone | markFailed
```

The user only sees: `createStation(...)`, register accounts, supply a handler. Everything else is internal.

## Operating rules

1. **Cross-check before you generate code.** If you cite a function, type, or method, it must be in the actual exports. Open `references/api-surface.md` to confirm — never paraphrase from memory.
2. **Single provider in v1.** `createStation` throws if `providers` has more than one key. If a user asks to register both Gmail and Outlook in one station, refuse and explain the v1 boundary (multi-provider routing is v2).
3. **All adapter and handler functions return `Promise<Result<T, E>>`.** Don't have user code throw — uncaught throws are caught by the kernel as `{ _tag: "Transient" }`, but that's a backstop, not the primary path.
4. **Atomicity is non-negotiable on `commitMessages`.** It must insert messages + advance cursor + enqueue trigger jobs in a single transaction. If the user is implementing a Store, this is the bug-magnet to call out first. See `references/store-contract.md`.
5. **Error tags drive runtime behavior.** `ResolverError._tag = "CredentialsRevoked"` mutates account state to `revoked`; `StoreError._tag = "Permanent"` during commit acks (not nacks) to prevent redelivery storms. See `references/errors.md` for the full mapping.
6. **Stable log event names are public contract.** When suggesting how to wire alerts/dashboards, use the names in `references/log-events.md`. Don't invent new ones.

## Common requests — recipe pointer

| User asks | Load |
|---|---|
| "wire up the station" / "minimal setup" | `templates/wire-station.ts` |
| "implement a Store for Postgres / SQLite / Redis" | `references/store-contract.md` + `templates/postgres-store.ts` |
| "schedule watch renewal" / "watch is expiring" | `references/gmail-provider.md` + `templates/renewal-cron.ts` |
| "how do I handle errors in my handler" | `references/errors.md` + `templates/handler-with-tagged-errors.ts` |
| "what does `event.X` log mean" / "what events fire" | `references/log-events.md` |
| "tune the worker" / "concurrency" / "backoff" / "max attempts" | `references/worker-and-backoff.md` |
| "set up Pub/Sub for Gmail" / "ADC" / "publisher grant" | `references/gmail-provider.md` |
| "send mail" / "fetch attachment bytes" / "Outlook" / "thread ops" | `references/out-of-scope.md` (refuse politely) |

## Things to refuse politely (v1 boundary)

If the user asks for any of these, explain it's deliberately out of scope for v1. The full list lives in `references/out-of-scope.md`; the most common asks:

- **Sending mail** — the stack is read-only (watch + history + get).
- **Attachment byte download helper** — parser produces `AttachmentRef`s; consumer fetches bytes via their own Gmail client call when needed.
- **Outlook** — the architecture supports it but the package itself is future work.
- **OAuth UX inside the Gmail provider** — consumer brings their own OAuth flow and provides the refresh token.
- **Multi-handler fan-out per event** — one handler; user fans out internally.
- **Push-style ingress (webhooks)** — pull-only in v1.

When refusing, also tell the user the workaround if there is one (e.g. for attachment bytes: "use `googleapis.gmail().users.messages.attachments.get` directly with the `attachmentId` from the AttachmentRef").

## Conformance shortcut

When the user is writing a Store adapter, point them at the conformance battery:

```ts
import { describe } from "vitest"
import { runStoreConformance } from "mailbox-station-conformance"
import { createMyStore } from "./my-store.js"

describe("my-store", () => {
  runStoreConformance({
    name: "my-store",
    makeStore: async () => ({
      store: createMyStore(),
      teardown: async () => { /* drop schema, close conn, etc. */ },
    }),
  })
})
```

If their adapter passes, it satisfies every invariant the core relies on. The basic-sqlite example in the repo is a working reference — passes the full battery.
