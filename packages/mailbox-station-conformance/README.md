# mailbox-station-conformance

Vitest-driven conformance battery for verifying user-supplied `StoreAdapter` implementations against the documented invariants in [`mailbox-station`](https://www.npmjs.com/package/mailbox-station) (atomic commit, idempotency on `(accountId, messageId)`, lease-based claims, state transitions, etc.).

```ts
import { describe } from "vitest"
import { runStoreConformance } from "mailbox-station-conformance"
import { createMyStore } from "./my-store.js"

describe("my Store adapter", () => {
  runStoreConformance({
    name: "my-store",
    makeStore: () => createMyStore(),
  })
})
```

If your adapter passes, it satisfies every contract `mailbox-station` relies on. Full details: [github.com/porkytheblack/mail-station](https://github.com/porkytheblack/mail-station).
