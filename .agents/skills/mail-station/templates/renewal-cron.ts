// Daily watch renewal. Gmail watches expire after 7 days, so renew them on a
// schedule. The package does NOT bring its own scheduler — pick whatever your
// stack uses (node-cron, system cron, GCP Cloud Scheduler, k8s CronJob, BullMQ).
//
// The renewal window in the provider config defaults to 24h, which assumes
// daily cron. If you cron weekly, raise renewalWindowMs proportionally.

// ---------- Option 1: in-process schedule (node-cron) -----------------------

import cron from "node-cron"
import type { Station } from "mailbox-station"

export const scheduleDailyWatchRenewal = <P extends { gmail: { renewExpiringWatches: () => unknown } }>(
  station: Station<P>,
): { stop: () => void } => {
  // 03:14 UTC every day. Pick a time that's quiet in your environment.
  const task = cron.schedule("14 3 * * *", async () => {
    const r = await station.providers.gmail.renewExpiringWatches()
    if (!r.ok) {
      // RenewError type is `never` per the API — this branch shouldn't be reachable,
      // but TypeScript will flag it if the API ever widens.
      console.error("[renewal] unexpected error", r.error)
      return
    }
    const { renewed, failed, revoked, details } = r.value
    console.log(`[renewal] renewed=${renewed} failed=${failed} revoked=${revoked}`)
    for (const d of details.filter((x) => x.outcome !== "renewed")) {
      console.warn(`[renewal] ${d.emailAddress} -> ${d.outcome}${d.error ? `: ${d.error}` : ""}`)
    }
  }, { timezone: "UTC" })
  task.start()
  return { stop: () => task.stop() }
}

// ---------- Option 2: stand-alone process invoked by an external scheduler ---
//
// Save as `bin/renew.ts` and call from system cron / Cloud Scheduler / k8s CronJob.
// Each invocation does one renewal pass and exits.

import { createStation } from "mailbox-station"
import { gmailProvider } from "gmail-station"
import { createMyStore } from "./my-store.js"

export const renewOnce = async (): Promise<void> => {
  const store = createMyStore({ /* ... */ })
  const station = createStation({
    store,
    handler: async () => ({ ok: true, value: undefined }),  // unused by renewal
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
  // No need to call station.start() — renewal doesn't open the ingress.
  // It only reads the Store and calls users.watch.
  const r = await station.providers.gmail.renewExpiringWatches()
  if (!r.ok) {
    console.error("[renewal] unexpected error", r.error)
    process.exit(1)
  }
  const { renewed, failed, revoked } = r.value
  console.log(`[renewal] renewed=${renewed} failed=${failed} revoked=${revoked}`)
}

// Uncomment if running directly:
// renewOnce().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
