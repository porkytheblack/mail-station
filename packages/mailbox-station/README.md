# mailbox-station

Provider-agnostic mailbox-watch core. Outbox commit, trigger worker, Store interface, handler interface. Promise + `Result` API by default; `/effect` subpath for Effect-TS users.

```ts
import { createStation, ok, UserId } from "mailbox-station"
import { gmailProvider } from "gmail-station"

const station = createStation({
  store,                         // your StoreAdapter implementation
  handler: async (message) => {  // your business logic per message
    console.log(message.subject, message.from.email)
    return ok(undefined)
  },
  providers: { gmail: gmailProvider({ /* ... */ }) },
})

await station.start()
```

Full design and API surface: [github.com/porkytheblack/mail-station](https://github.com/porkytheblack/mail-station) — see [`guides/design-spec.md`](https://github.com/porkytheblack/mail-station/blob/main/guides/design-spec.md) and [`guides/mailbox-station.md`](https://github.com/porkytheblack/mail-station/blob/main/guides/mailbox-station.md).
