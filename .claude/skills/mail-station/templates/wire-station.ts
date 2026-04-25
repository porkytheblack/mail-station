// Minimal mailbox-station + gmail-station wire-up.
// Copy into a fresh Node project and adapt the Store + handler to your needs.
//
// Required env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GCP_PROJECT_ID,
//               PUBSUB_TOPIC, PUBSUB_SUBSCRIPTION, plus Application Default
//               Credentials so the Pub/Sub SDK can authenticate.

import { consoleLogger, createStation, ok, UserId } from "mailbox-station"
import { gmailProvider } from "gmail-station"
import { createMyStore } from "./my-store.js"   // your StoreAdapter — see postgres-store.ts template

const main = async () => {
  const store = createMyStore({ /* connection config */ })

  const station = createStation({
    store,
    logger: consoleLogger,            // omit to use the default; or pass your own structured logger

    handler: async (message, ctx) => {
      // your business logic. Return ok(undefined) on success,
      // err({ _tag: "Transient", message }) to retry,
      // err({ _tag: "Permanent", message }) to dead-letter immediately.
      console.log(`[handler] ${message.subject} from ${message.from.email}`)
      return ok(undefined)
    },

    config: {
      // All optional — these are the defaults; uncomment to override.
      // triggerConcurrency: 8,
      // claimBatchSize:     16,
      // leaseDurationMs:    5 * 60_000,
      // maxAttempts:        10,
      // backoff:            { baseMs: 30_000, factor: 2, maxMs: 5*60_000, jitterFactor: 0.25 },
    },

    providers: {
      gmail: gmailProvider({
        googleClientId:     process.env.GOOGLE_CLIENT_ID!,
        googleClientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        gcpProjectId:       process.env.GCP_PROJECT_ID!,
        pubsubTopic:        process.env.PUBSUB_TOPIC!,
        pubsubSubscription: process.env.PUBSUB_SUBSCRIPTION!,
        // labelFilter: ["INBOX"], // default; pass `null` to watch everything
      }),
    },
  })

  await station.start()

  // Register an account once you have a refresh token from your OAuth flow.
  // Idempotent on (provider, emailAddress); subsequent calls return DuplicateAccount.
  if (process.env.REGISTER_EMAIL && process.env.REFRESH_TOKEN) {
    const r = await station.providers.gmail.register({
      userId:       UserId(process.env.USER_ID ?? "user-1"),
      emailAddress: process.env.REGISTER_EMAIL,
      refreshToken: process.env.REFRESH_TOKEN,
    })
    if (!r.ok) {
      if (r.error._tag === "DuplicateAccount") {
        console.log(`[register] ${process.env.REGISTER_EMAIL} already registered — continuing`)
      } else {
        console.error("[register] failed:", r.error)
        await station.stop()
        process.exit(1)
      }
    } else {
      console.log(`[register] ok — accountId=${r.value.accountId}`)
    }
  }

  // Graceful shutdown.
  process.on("SIGTERM", () => void station.stop())
  process.on("SIGINT",  () => void station.stop())
  await station.wait()
}

main().catch((e) => { console.error("[fatal]", e); process.exit(1) })
