# Gmail provider

`gmail-station` plugs into `mailbox-station`'s `createStation({ providers })` map. It owns: the Gmail API client (with OAuth2 refresh + writeback), the watch-lifecycle manager, the Pub/Sub pull ingress, and the MIME parser.

## Configuration

```ts
import { gmailProvider } from "gmail-station"

const provider = gmailProvider({
  // Required
  googleClientId:     process.env.GOOGLE_CLIENT_ID!,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  gcpProjectId:       process.env.GCP_PROJECT_ID!,
  pubsubTopic:        process.env.PUBSUB_TOPIC!,           // projects/<id>/topics/<name>
  pubsubSubscription: process.env.PUBSUB_SUBSCRIPTION!,    // pull-type, fully-qualified

  // Optional with sensible defaults
  labelFilter:      ["INBOX"],          // null watches everything; default ["INBOX"]
  pullConcurrency:  4,                  // Pub/Sub message handlers in flight
  fetchConcurrency: 8,                  // messages.get parallelism per resolver
  renewalWindowMs:  24 * 60 * 60 * 1000,// renew accounts whose watch expires within 24h

  // Pub/Sub auth (default: ADC)
  pubsubAuth: { kind: "adc" },
  // | { kind: "keyFile", keyFilename: "/path/to/sa.json" }
  // | { kind: "credentials", credentials: serviceAccountKeyJson }
})
```

## GCP-side prerequisites (one-time)

1. **Enable APIs:** `gmail.googleapis.com` and `pubsub.googleapis.com` on the project.
2. **Create a Pub/Sub topic.**
3. **Grant Gmail's service account publisher rights on the topic:**
   - principal: `gmail-api-push@system.gserviceaccount.com`
   - role: `roles/pubsub.publisher`
   - Without this, `users.watch` returns a permission error.
4. **Create a pull-type subscription** on the topic. Ack deadline 30s is fine.
5. **Application Default Credentials** (or a key file via `pubsubAuth.kind: "keyFile"`) with `roles/pubsub.subscriber` on the subscription.

The repo's `examples/gmail-e2e/scripts/setup-gcp.sh` is an idempotent gcloud script that does steps 1–4.

## Account registration

The user runs their own OAuth flow (out of scope for the package — see `out-of-scope.md`). They end up with a refresh token, scoped at minimum to `https://www.googleapis.com/auth/gmail.readonly` (or `gmail.modify`). Mint with `access_type=offline&prompt=consent` so Google actually issues the refresh token.

```ts
import { UserId } from "mailbox-station"

const r = await station.providers.gmail.register({
  userId:       UserId("user-123"),
  emailAddress: "alice@example.com",
  refreshToken: "<from your OAuth flow>",
})

if (!r.ok) {
  switch (r.error._tag) {
    case "DuplicateAccount":   // (provider, emailAddress) already registered
    case "InvalidGrant":       // refresh token already revoked or wrong scope
    case "ProviderTransient":  // 5xx/429/network — retry
    case "ProviderPermanent":  // 4xx that isn't invalid_grant
    case "StoreError":         // adapter failed (see message for tag)
  }
} else {
  console.log("registered", r.value.accountId)
}
```

What `register` does internally:
1. Validates the refresh token via a token-endpoint round trip (fast-fail on `InvalidGrant` before calling watch).
2. Persists the account via `Store.createAccount`.
3. Calls Gmail `users.watch` to start notifications, with the configured topic + label filter.
4. Persists the returned `historyId` (initial cursor) and `expiration` (`watchExpiresAt`).

The first Pub/Sub notification after this seeds normal pipeline operation.

## Watch lifecycle

Gmail watches expire after 7 days. The provider does NOT bring its own scheduler. The user calls:

```ts
const summary = await station.providers.gmail.renewExpiringWatches()
// { renewed, failed, revoked, details: [...] }
```

…on a daily-ish cron (`templates/renewal-cron.ts`). Internally it:
1. `listAccountsExpiringWatch(provider="gmail", before=now+renewalWindowMs)`.
2. For each, calls `users.watch` again.
3. Updates cursor + expiration.
4. If any account returns `invalid_grant`, status is moved to `revoked` and counted in `summary.revoked`.

Default `renewalWindowMs` is 24h, which assumes daily cron. If your cron runs less frequently (e.g. weekly), you must increase the window proportionally — otherwise watches expire between runs.

## What happens when a watch lapses past 7 days

The next Pub/Sub notification's `historyId` is older than what `history.list` will accept. Gmail returns 404; `gmail-station` catches it as a `HistoryGone` signal, logs `event.history_gone`, advances the cursor to the latest notification's `historyId`, and continues. **Messages in the gap are not auto-resynced.** A full-resync recipe via `users.messages.list` is out of scope (the user can layer it on top using the exposed Gmail client if needed).

## Notification payload

`gmail-station` decodes the Pub/Sub message into:

```ts
type Notification = { emailAddress: string; historyId: string }
```

…then looks up the account by `(provider="gmail", emailAddress)`, runs `history.list` from the stored cursor, fetches each new message via `messages.get`, parses MIME, and produces the `MailMessage[]` + new cursor.

## OAuth2 refresh writeback

When the underlying OAuth2 client refreshes an access token (every ~1h), `gmail-station` writes the new access token + expiry back to the Store via `updateAccount`. Fire-and-forget — if writeback fails, the next call refreshes again. The refresh token itself rarely changes.

## What's stored in `MailboxAccount.credentials`

```ts
{
  refreshToken:        string,
  accessToken?:        string,
  accessTokenExpiresAt?: string  // ISO datetime, since stored as JSON
}
```

Encrypt at the adapter layer if your store needs it — the core treats `credentials` as opaque.

## Multi-label watches

Gmail's `users.watch` accepts multiple labels, but `history.list` accepts only ONE `labelId`. So when you pass multiple labels in `labelFilter`, the resolver does client-side filtering after fetching. This is documented in design-spec §15. For most users, `["INBOX"]` is what you want.

## Pure helpers exported (for tests / one-off processing)

```ts
import { decodeNotification, parseGmailMessage } from "gmail-station"

decodeNotification(buf: Buffer): Result<Notification, IngressError>
parseGmailMessage(msg: Schema$Message, accountId: AccountId): MailMessage
```

Useful when writing a custom test fixture or doing one-off inspection of a saved Gmail payload.
