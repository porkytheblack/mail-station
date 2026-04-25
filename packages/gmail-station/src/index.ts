export { gmailProvider } from "./internal/plugin.js"
export { decodeNotification } from "./internal/notification.js"
export { parseGmailMessage } from "./internal/parser.js"
export { defaultGmailClientFactory } from "./internal/client.js"

export type {
  GmailConfig,
  GmailCredentials,
  GmailClient,
  GmailClientFactory,
  GmailProviderApi,
  RegisterError,
  RenewSummary,
  Notification,
  ServiceAccountKey,
  SubscriptionFactory,
  SubscriptionLike,
  SubscriptionMessage,
  ResolvedGmailConfig,
} from "./internal/types.js"
