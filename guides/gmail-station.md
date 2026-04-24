# gmail-station

Gmail provider package for `mailbox-station`. Translates Gmail's Pub/Sub push notification model into the core's `MailboxEvent` / `MailMessage` shape and manages Gmail-specific lifecycle (watch renewal, history.list cursors, OAuth2 refresh).

## What this package adds on top of the core

`mailbox-station` knows nothing about Gmail. This package brings:

- A **Gmail API client** wrapping `users.watch`, `users.history.list`, `users.messages.get`, `users.stop`. Handles OAuth2 token refresh per account and writes refreshed access tokens back to the Store.
- A **MessageResolver** for Gmail. Given a Pub/Sub notification (`{ emailAddress, historyId }`), it diffs from the account's `lastEventCursor` via `history.list`, fetches each new message via `messages.get`, parses the MIME tree into the core's `MailMessage` shape, and returns them with the new cursor value.
- A **Pub/Sub pull ingress**. Long-running consumer of a Pub/Sub subscription that decodes notifications and feeds them into the core pipeline. Acks on successful commit, nacks on failure (so Pub/Sub redelivers).
- A **Watch manager**. Calls `users.watch` on register, persists the returned `historyId` and `expiration`, and exposes a renewal effect that the user schedules (daily cron). Recovers from expired watches by re-calling watch and accepting the new cursor.
- A **MIME parser**. Walks the `payload.parts` tree, decodes base64url bodies, extracts headers (lowercased), pulls out attachment references. Produces the core's `MailMessage`.

## The flow, end to end

```
user sends an email to a watched account
  → Gmail publishes { emailAddress, historyId } to your Pub/Sub topic
  → gmail-station's pull ingress receives the Pub/Sub message
  → ingress hands it to the core pipeline as a MailboxEvent
  → core asks the Gmail MessageResolver to resolve the event:
      - look up account by emailAddress (via Store)
      - history.list from lastEventCursor → [messageId, ...]
      - messages.get each → parse MIME → MailMessage[]
      - return (messages, newCursor = history.list response's historyId)
  → core commits atomically: messages + cursor + trigger jobs
  → core acks the Pub/Sub message
  → core's worker claims the trigger jobs and runs the user's handler
```

The user only sees: "I registered an account, I get my handler called per new message."

## Configuration

Provider-specific config lives here, not in the core:

- Google OAuth client ID and secret.
- GCP project ID.
- Pub/Sub topic name and subscription name.
- Label filter (default `["INBOX"]`; pass `null` to watch everything).
- Pull concurrency for the ingress.

## Account registration

The user does the OAuth flow themselves (out of scope for this package — every app's auth UX is different) and ends up with a refresh token. They then call `register` with `{ userId, emailAddress, refreshToken }`. The package:

1. Persists the `MailboxAccount` via the Store.
2. Calls `users.watch` to start notifications.
3. Stores the returned `historyId` as the initial cursor and the `expiration` as the watch deadline.

The first Pub/Sub notification after this seeds normal pipeline operation.

## Watch lifecycle

Gmail watches expire after 7 days. This package exposes a renewal effect that:

1. Lists accounts whose `watchExpiresAt` is within the renewal window.
2. Calls `users.watch` for each.
3. Updates the cursor and expiration in the Store.

Scheduling is the user's call — typical pattern is daily via the user's existing scheduler. The package does not bring its own cron.

If a watch lapses past 7 days, the next history.list returns 404. The resolver catches `HistoryGoneError`, logs it, advances the cursor to the latest notification's `historyId`, and continues. Messages in the gap are not re-synced automatically; the user can layer a full-resync recipe on top using `users.messages.list` if they need it.

## OAuth2 token refresh

The Gmail client builds an OAuth2 client per request from the account's stored refresh token. The googleapis SDK handles refresh automatically. When refresh happens, the client subscribes to the `tokens` event and writes the new access token + expiry back to the Store via `updateAccountTokens`. Fire-and-forget; if the writeback fails, the next call refreshes again.

## What the user provides

- A `Store` adapter (from the core's interface). Same one they'd use for any provider.
- A `MessageHandler` (from the core's interface). Receives `MailMessage`.
- A `GmailConfig` value (this package's interface).
- An OAuth flow they've built themselves, that produces refresh tokens.
- A scheduler call once a day to run the watch renewal effect.

## What the user does not need to know

- Gmail's history.list semantics, cursor management, 7-day expiration, MIME tree walking, base64url quirks, label filtering syntax, OAuth2 refresh mechanics. All hidden.
- Pub/Sub message format, ack/nack timing, redelivery behavior. All hidden.

## Composition

```
user code
  ├── Store adapter (their choice)
  ├── MessageHandler (their logic)
  ├── GmailConfig (their credentials)
  │
  └── runtime = mailbox-station core
                + gmail-station provider
                + their adapters
```

## Outlook later

The whole point of splitting `mailbox-station` out is that `outlook-station` is the same shape as this file with Microsoft Graph in place of Gmail API and Graph webhooks in place of Pub/Sub. The user's Store, handler, and core stay identical; only the provider package and its config swap. A single deployment can run both providers against the same outbox without changes to the core.

## Out of scope for v1

- Sending mail. Read-only watch, history, get.
- Push delivery (Pub/Sub push subscription with a webhook). Pull only for now.
- Attachment download. The parser produces `AttachmentRef`s with IDs; fetching the bytes is a follow-up call the user makes via the Gmail client if they need it.
- Thread-level operations. Messages are flat; threading info is in the message but not aggregated.
