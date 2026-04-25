# gmail-station

Gmail provider for [`mailbox-station`](https://www.npmjs.com/package/mailbox-station). Wraps `@googleapis/gmail`, OAuth2 refresh, the `users.watch` lifecycle, Pub/Sub pull ingress, and a pure MIME parser.

```ts
import { gmailProvider } from "gmail-station"

const provider = gmailProvider({
  googleClientId:     process.env.GOOGLE_CLIENT_ID!,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  gcpProjectId:       process.env.GCP_PROJECT_ID!,
  pubsubTopic:        process.env.PUBSUB_TOPIC!,
  pubsubSubscription: process.env.PUBSUB_SUBSCRIPTION!,
})
```

Plug into `createStation({ providers: { gmail: provider } })` from `mailbox-station`. Then call `station.providers.gmail.register({ userId, emailAddress, refreshToken })` to start watching an account.

Full design and API surface: [github.com/porkytheblack/mail-station](https://github.com/porkytheblack/mail-station) — see [`guides/gmail-station.md`](https://github.com/porkytheblack/mail-station/blob/main/guides/gmail-station.md).
