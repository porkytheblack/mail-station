import type {
  ProviderBuildDeps,
  ProviderFactory,
  ProviderRuntime,
} from "mailbox-station"
import { startIngress } from "./ingress.js"
import { createGmailResolver } from "./resolver.js"
import { createWatchManager } from "./watch.js"
import type {
  GmailConfig,
  GmailProviderApi,
  ResolvedGmailConfig,
} from "./types.js"

const resolveConfig = (input: GmailConfig): ResolvedGmailConfig => ({
  googleClientId: input.googleClientId,
  googleClientSecret: input.googleClientSecret,
  gcpProjectId: input.gcpProjectId,
  pubsubTopic: input.pubsubTopic,
  pubsubSubscription: input.pubsubSubscription,
  labelFilter: input.labelFilter === undefined ? ["INBOX"] : input.labelFilter,
  pullConcurrency: input.pullConcurrency ?? 4,
  fetchConcurrency: input.fetchConcurrency ?? 8,
  renewalWindowMs: input.renewalWindowMs ?? 24 * 60 * 60 * 1000,
  pubsubAuth: input.pubsubAuth ?? { kind: "adc" },
  ...(input.clientFactory ? { clientFactory: input.clientFactory } : {}),
  ...(input.subscriptionFactory ? { subscriptionFactory: input.subscriptionFactory } : {}),
})

export const gmailProvider = (input: GmailConfig): ProviderFactory<GmailProviderApi> => ({
  build: (deps: ProviderBuildDeps): ProviderRuntime & { api: GmailProviderApi } => {
    const config = resolveConfig(input)
    const runtimeDeps = { ...deps, config }
    const resolver = createGmailResolver(runtimeDeps)
    const watchManager = createWatchManager(runtimeDeps)
    const ingress = startIngress(runtimeDeps)

    const api: GmailProviderApi = {
      register: watchManager.register,
      renewExpiringWatches: watchManager.renewExpiringWatches,
    }

    return {
      resolver,
      api,
      start: () => ingress.start(),
      stop: () => ingress.stop(),
      wait: () => ingress.wait(),
    }
  },
})
