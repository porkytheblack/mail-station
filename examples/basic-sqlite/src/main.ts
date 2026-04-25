import { createStation, ok, UserId } from "mailbox-station"
import { gmailProvider } from "gmail-station"
import { createSqliteStore } from "./sqlite-store.js"

/**
 * Runnable smoke test that wires up:
 *   - SQLite-backed Store adapter (this directory)
 *   - The provider-agnostic `mailbox-station` core
 *   - The `gmail-station` provider plugin
 *
 * Set the env vars below, drop a Google refresh token in REFRESH_TOKEN, and
 * run `node --experimental-strip-types src/main.ts` to see it process the
 * first inbox event.
 */
const main = async () => {
  const env = (key: string): string => {
    const v = process.env[key]
    if (!v) throw new Error(`missing env: ${key}`)
    return v
  }

  const store = createSqliteStore(process.env.SQLITE_PATH ?? "./mail.db")

  const station = createStation({
    store,
    handler: async (message) => {
      console.log(`[handler] ${message.subject} from ${message.from.email}`)
      return ok(undefined)
    },
    providers: {
      gmail: gmailProvider({
        googleClientId: env("GOOGLE_CLIENT_ID"),
        googleClientSecret: env("GOOGLE_CLIENT_SECRET"),
        gcpProjectId: env("GCP_PROJECT_ID"),
        pubsubTopic: env("PUBSUB_TOPIC"),
        pubsubSubscription: env("PUBSUB_SUBSCRIPTION"),
      }),
    },
  })

  await station.start()

  if (process.env.REGISTER_EMAIL && process.env.REFRESH_TOKEN) {
    const r = await station.providers.gmail.register({
      userId: UserId(process.env.USER_ID ?? "user-1"),
      emailAddress: process.env.REGISTER_EMAIL,
      refreshToken: process.env.REFRESH_TOKEN,
    })
    console.log("[register]", r)
  }

  process.on("SIGTERM", () => void station.stop())
  process.on("SIGINT", () => void station.stop())
  await station.wait()
  store.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
