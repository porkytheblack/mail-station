import { consoleLogger, createStation, ok, UserId } from "mailbox-station"
import { gmailProvider } from "gmail-station"
import { createSqliteStore } from "./store.js"

type EnvSpec = { name: string; required: boolean; description: string }

const ENV_SPEC: ReadonlyArray<EnvSpec> = [
  { name: "GOOGLE_CLIENT_ID",     required: true,  description: "OAuth client id from GCP console" },
  { name: "GOOGLE_CLIENT_SECRET", required: true,  description: "OAuth client secret from GCP console" },
  { name: "GCP_PROJECT_ID",       required: true,  description: "GCP project id, e.g. my-project-123456" },
  { name: "PUBSUB_TOPIC",         required: true,  description: "fully-qualified, e.g. projects/<id>/topics/<name>" },
  { name: "PUBSUB_SUBSCRIPTION",  required: true,  description: "pull-type, e.g. projects/<id>/subscriptions/<name>" },
  { name: "REGISTER_EMAIL",       required: true,  description: "the gmail address you authorized" },
  { name: "REFRESH_TOKEN",        required: true,  description: "refresh token from your OAuth flow (gmail.readonly scope)" },
  { name: "USER_ID",              required: false, description: "opaque user id (defaults to user-1)" },
  { name: "SQLITE_PATH",          required: false, description: "sqlite db path (defaults to ./e2e.db)" },
]

const loadEnv = (): Record<string, string> => {
  const missing: string[] = []
  const out: Record<string, string> = {}
  for (const spec of ENV_SPEC) {
    const v = process.env[spec.name]
    if (v) out[spec.name] = v
    else if (spec.required) missing.push(spec.name)
  }
  if (missing.length > 0) {
    console.error("missing required env vars:")
    for (const name of missing) {
      const spec = ENV_SPEC.find((s) => s.name === name)!
      console.error(`  ${name.padEnd(22)} ${spec.description}`)
    }
    console.error("\ncopy .env.example to .env and fill it in, or pass via --env-file=<path>.")
    process.exit(1)
  }
  return out
}

const formatAddr = (a: { name: string | null; email: string }): string =>
  a.name ? `${a.name} <${a.email}>` : a.email

const formatMessage = (m: import("mailbox-station").MailMessage): string => {
  const lines: string[] = []
  lines.push("--------------------------------------------------------")
  lines.push("[handler] new message")
  lines.push(`  account:    ${m.accountId}`)
  lines.push(`  message:    ${m.messageId}`)
  lines.push(`  thread:     ${m.threadId ?? "(none)"}`)
  lines.push(`  from:       ${formatAddr(m.from)}`)
  lines.push(`  to:         ${m.to.map(formatAddr).join(", ") || "(none)"}`)
  if (m.cc.length > 0) lines.push(`  cc:         ${m.cc.map(formatAddr).join(", ")}`)
  if (m.bcc.length > 0) lines.push(`  bcc:        ${m.bcc.map(formatAddr).join(", ")}`)
  if (m.replyTo.length > 0) lines.push(`  replyTo:    ${m.replyTo.map(formatAddr).join(", ")}`)
  lines.push(`  subject:    ${m.subject || "(empty)"}`)
  lines.push(`  receivedAt: ${m.receivedAt.toISOString()}`)
  lines.push(`  labels:     ${m.labels.join(", ") || "(none)"}`)
  if (m.attachments.length > 0) {
    lines.push(`  attachments:`)
    for (const a of m.attachments) {
      const flags: string[] = []
      if (a.inline) flags.push("inline")
      if (a.contentId) flags.push(`cid=${a.contentId}`)
      const flagStr = flags.length > 0 ? `  [${flags.join(", ")}]` : ""
      lines.push(`    - ${a.filename} (${a.mimeType}, ${a.sizeBytes} bytes)${flagStr}`)
    }
  }
  const bodyTextLen = m.bodyText.length
  const bodyHtmlLen = m.bodyHtml.length
  if (bodyTextLen > 0 || bodyHtmlLen > 0) {
    lines.push(`  bodySizes:  text=${bodyTextLen}B html=${bodyHtmlLen}B`)
  }
  const preview = m.bodyText.replace(/\s+/g, " ").trim().slice(0, 240)
  if (preview) lines.push(`  bodyText:   ${preview}${bodyTextLen > 240 ? "..." : ""}`)
  lines.push("--------------------------------------------------------")
  return lines.join("\n")
}

const main = async () => {
  const env = loadEnv()
  const store = createSqliteStore(env.SQLITE_PATH ?? "./e2e.db")

  console.log("[boot] starting gmail-e2e")
  console.log(`[boot]   project:      ${env.GCP_PROJECT_ID}`)
  console.log(`[boot]   topic:        ${env.PUBSUB_TOPIC}`)
  console.log(`[boot]   subscription: ${env.PUBSUB_SUBSCRIPTION}`)
  console.log(`[boot]   registering:  ${env.REGISTER_EMAIL}`)
  console.log(`[boot]   sqlite:       ${env.SQLITE_PATH ?? "./e2e.db"}`)

  const station = createStation({
    store,
    logger: consoleLogger,
    handler: async (message) => {
      console.log(formatMessage(message))
      return ok(undefined)
    },
    providers: {
      gmail: gmailProvider({
        googleClientId: env.GOOGLE_CLIENT_ID!,
        googleClientSecret: env.GOOGLE_CLIENT_SECRET!,
        gcpProjectId: env.GCP_PROJECT_ID!,
        pubsubTopic: env.PUBSUB_TOPIC!,
        pubsubSubscription: env.PUBSUB_SUBSCRIPTION!,
      }),
    },
  })

  await station.start()

  const r = await station.providers.gmail.register({
    userId: UserId(env.USER_ID ?? "user-1"),
    emailAddress: env.REGISTER_EMAIL!,
    refreshToken: env.REFRESH_TOKEN!,
  })

  if (!r.ok) {
    if (r.error._tag === "DuplicateAccount") {
      console.log(`[register] account already registered for ${env.REGISTER_EMAIL} — continuing`)
    } else {
      console.error("[register] failed:", r.error)
      await station.stop()
      store.close()
      process.exit(1)
    }
  } else {
    console.log(`[register] ok — accountId=${r.value.accountId}`)
  }

  console.log("\n[ready] watching for new mail. send an email to:", env.REGISTER_EMAIL)
  console.log("[ready] press ctrl+c to stop.\n")

  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`\n[shutdown] received ${signal}, stopping...`)
    await station.stop()
    store.close()
    console.log("[shutdown] done.")
    process.exit(0)
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT",  () => void shutdown("SIGINT"))

  await station.wait()
}

main().catch((e) => {
  console.error("[fatal]", e)
  process.exit(1)
})
