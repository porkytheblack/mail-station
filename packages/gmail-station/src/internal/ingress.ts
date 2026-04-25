import { PubSub } from "@google-cloud/pubsub"
import type { ClientConfig } from "@google-cloud/pubsub"
import type { GmailRuntimeDeps, ResolvedGmailConfig, SubscriptionLike, SubscriptionMessage } from "./types.js"

const RESTART_DELAYS_MS = [1_000, 5_000, 30_000]
const MAX_RESTART_ATTEMPTS = 10
const sleep = (ms: number, signal: { aborted: boolean; onAbort: (cb: () => void) => void }) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal.onAbort(() => {
      clearTimeout(t)
      resolve()
    })
  })

export type IngressHandle = {
  start(): Promise<void>
  stop(): Promise<void>
  wait(): Promise<void>
}

const sdkSubscriptionFactory = (config: ResolvedGmailConfig): SubscriptionLike => {
  const clientConfig: ClientConfig = { projectId: config.gcpProjectId }
  const auth = config.pubsubAuth
  if (auth.kind === "keyFile") clientConfig.keyFilename = auth.keyFilename
  else if (auth.kind === "credentials") clientConfig.credentials = auth.credentials as any

  const pubsub = new PubSub(clientConfig)
  const sub = pubsub.subscription(config.pubsubSubscription, {
    flowControl: { maxMessages: config.pullConcurrency },
    ackDeadline: 60,
  })

  const adapt: SubscriptionLike = {
    on: (...args: any[]) => {
      ;(sub as any).on(...args)
      return adapt
    },
    removeAllListeners: () => sub.removeAllListeners(),
    close: async () => {
      await sub.close()
    },
    metadata: async () => {
      const [meta] = await sub.getMetadata()
      const pushConfig = (meta as { pushConfig?: { pushEndpoint?: string } }).pushConfig
      return { pushConfigPresent: !!(pushConfig && pushConfig.pushEndpoint) }
    },
  }
  return adapt
}

export const startIngress = (deps: GmailRuntimeDeps): IngressHandle => {
  const { config, logger, pipeline } = deps
  let stopping = false
  let runDone: Promise<void> | null = null
  let currentSub: SubscriptionLike | null = null
  const stopCallbacks: Array<() => void> = []
  const abortSignal = {
    get aborted() {
      return stopping
    },
    onAbort: (cb: () => void) => {
      if (stopping) cb()
      else stopCallbacks.push(cb)
    },
  }

  const factory = config.subscriptionFactory ?? sdkSubscriptionFactory

  const oneRun = async (): Promise<{ recoverable: boolean }> => {
    const sub = factory(config)
    currentSub = sub

    return await new Promise<{ recoverable: boolean }>((resolve) => {
      let resolved = false
      const finish = (recoverable: boolean) => {
        if (resolved) return
        resolved = true
        sub.removeAllListeners()
        sub.close().catch(() => {})
        currentSub = null
        resolve({ recoverable })
      }

      // Attach listeners FIRST so we never lose an early error/close that
      // might fire while metadata() is in flight.
      sub.on("message", async (msg: SubscriptionMessage) => {
        try {
          const decision = await pipeline.processEvent({
            eventId: msg.id,
            providerPayload: msg.data,
            receivedAt: msg.publishTime ?? new Date(),
          })
          if (decision === "ack") msg.ack()
          else msg.nack()
        } catch (e) {
          // Belt-and-braces: kernel catches throws, but if anything escapes,
          // ack to avoid jamming the loop and emit log.
          logger.error("ingress.handler_threw", {
            error: e instanceof Error ? e.message : String(e),
          })
          msg.ack()
        }
      })

      sub.on("error", (e: Error) => {
        logger.warn("ingress.subscription_lost", { provider: "gmail", error: e.message })
        finish(true)
      })

      sub.on("close", () => {
        finish(stopping ? false : true)
      })

      // Run the metadata check inside the promise so failures still resolve
      // the run cleanly.
      const checkMetadata = async () => {
        if (!sub.metadata) {
          logger.info("ingress.started", {
            provider: "gmail",
            subscription: config.pubsubSubscription,
          })
          return
        }
        try {
          const meta = await sub.metadata()
          if (meta.pushConfigPresent) {
            logger.error("ingress.subscription_misconfigured", {
              provider: "gmail",
              subscription: config.pubsubSubscription,
              reason: "push-type subscription not supported; use pull",
            })
            finish(false)
            return
          }
          logger.info("ingress.started", {
            provider: "gmail",
            subscription: config.pubsubSubscription,
          })
        } catch (e) {
          logger.error("ingress.subscription_metadata_failed", {
            provider: "gmail",
            subscription: config.pubsubSubscription,
            error: e instanceof Error ? e.message : String(e),
          })
          finish(false)
        }
      }
      void checkMetadata()

      // If stop() was called between factory() and now, close immediately.
      if (stopping) finish(false)
    })
  }

  const supervise = async (): Promise<void> => {
    let attempt = 0
    while (!stopping) {
      const { recoverable } = await oneRun()
      if (!recoverable || stopping) return
      if (attempt >= MAX_RESTART_ATTEMPTS) {
        logger.error("ingress.giving_up", {
          provider: "gmail",
          attempts: attempt,
          reason: "max restart attempts reached; check Pub/Sub credentials and subscription config",
        })
        return
      }
      const delayIdx = Math.min(RESTART_DELAYS_MS.length - 1, attempt)
      const delay = RESTART_DELAYS_MS[delayIdx]!
      attempt += 1
      logger.warn("ingress.restarting", { provider: "gmail", attempt, delayMs: delay })
      await sleep(delay, abortSignal)
    }
  }

  return {
    start: async () => {
      if (runDone) return
      runDone = supervise()
    },
    stop: async () => {
      stopping = true
      for (const cb of stopCallbacks) cb()
      stopCallbacks.length = 0
      if (currentSub) {
        // Don't removeAllListeners — the close handler resolves the run promise.
        await currentSub.close().catch(() => {})
        currentSub = null
      }
      if (runDone) await runDone
    },
    wait: async () => {
      if (runDone) await runDone
    },
  }
}
