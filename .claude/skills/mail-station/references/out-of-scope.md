# Out of scope (v1)

These features are deliberately not in v1 (design-spec §14). When a user asks for one, refuse politely and tell them the workaround.

## The list

| Feature | Workaround |
|---|---|
| **Sending mail** | Use a separate library (Nodemailer, Resend, Postmark). The stack is read-only. |
| **Push-style ingress (webhook)** | Pull-only in v1. Webhook ingress is a future provider extension. |
| **Attachment byte download helper** | The parser produces `AttachmentRef` with `attachmentId`. Fetch bytes with `googleapis.gmail().users.messages.attachments.get` directly using your own OAuth client (or grab the underlying client via `defaultGmailClientFactory`). |
| **Thread-level operations** | Messages are flat. `MailMessage.threadId` is exposed but no thread aggregation API. Group by `threadId` in the consumer. |
| **Charset conversion for non-UTF-8 mail** | Bodies assumed UTF-8 in v1. Legacy ISO-8859-* / GB2312 mail decodes incorrectly. If the consumer needs this, post-process `bodyText` themselves. |
| **HTML sanitization** | `bodyHtml` is raw. Use DOMPurify or sanitize-html on the consumer side before rendering. |
| **Full-resync after watch lapse > 7 days** | Resolver advances the cursor past the gap. Consumer can write a one-shot using `users.messages.list` to backfill if needed. |
| **Account deletion API** | No `deleteAccount`. Consumer can delete the row directly in their Store; the kernel never queries deleted accounts. |
| **Label normalization across providers** | Labels stay raw (Gmail's `INBOX` is different from Outlook's `Inbox`). Consumer maps in their domain layer. |
| **Outlook provider** | Architecture supports it, package is future. Today: gmail-station only. |
| **OAuth flow inside the Gmail provider** | Every app's auth UX is different. Consumer runs their own flow and provides the refresh token to `register`. |
| **Multi-handler fan-out per event type** | One handler. Fan out internally based on labels, sender, etc. |
| **Lease heartbeating** | Set `leaseDurationMs` to cover your worst-case handler runtime. No mid-handler renewal. |
| **Per-account (per-key) handler serialization** | All in-flight slots are general-purpose. If you need serial-per-account, gate inside the handler with your own lock (Redis, DB advisory lock). |
| **State-change push callbacks** (`onAccountRevoked`, etc.) | React to log events instead — `account.revoked`, `trigger.dead_lettered`. Wire them through your logger. |
| **Retention policies on stored messages or jobs** | Adapter author decides. The kernel doesn't prune. |
| **Cross-account batching** | `commitMessages` is single-account. The kernel never batches across accounts. |
| **Metrics SDKs (Prometheus / OpenTelemetry / statsd)** | Use the structured `StationLogger` to emit metrics yourself. The skill's `references/log-events.md` lists the stable event names. |
| **GCP resource provisioning (topic, subscription, IAM)** | Consumer responsibility. The repo has an idempotent gcloud script at `examples/gmail-e2e/scripts/setup-gcp.sh` to crib from. |

## Refusal phrasing template

When a user asks for one of these, lead with the workaround, not the refusal:

> "v1 doesn't include X — consumer responsibility. The way most users handle it is Y." [optional one-line on why it's out of scope: "Every app's auth UX is different" / "Bytes are large; refs let you fetch lazily" / etc.]

Don't volunteer to add it to the package — that's a v2 conversation owned by the maintainers.
