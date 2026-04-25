// Sends a battery of test emails through Resend to exercise the gmail-station
// MIME parser end-to-end. Run with `pnpm --filter gmail-e2e-example send:fixtures`
// while `start` is running in another terminal (or background).

type Fixture = {
  readonly name: string
  readonly subject: string
  readonly text?: string
  readonly html?: string
  readonly cc?: ReadonlyArray<string>
  readonly bcc?: ReadonlyArray<string>
  readonly reply_to?: ReadonlyArray<string>
  readonly headers?: Readonly<Record<string, string>>
  readonly attachments?: ReadonlyArray<{
    readonly filename: string
    readonly content: string         // base64
    readonly content_type?: string
    readonly content_id?: string
  }>
}

// 1x1 red PNG, base64.
const PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8z/D/PwAGAgL/hQt5xQAAAABJRU5ErkJggg=="

// "hello" as a tiny text file payload, base64.
const TEXT_FILE_B64 = Buffer.from("hello from a text attachment\n").toString("base64")

const FIXTURES: ReadonlyArray<Fixture> = [
  {
    name: "01-plain-text",
    subject: "[fixture] plain text only",
    text: "This is a plain-text email. One body part. No HTML.",
  },
  {
    name: "02-html-only",
    subject: "[fixture] html only",
    html: "<h1>Hello</h1><p>HTML-only message with <strong>formatting</strong> and <a href=\"https://example.com\">a link</a>.</p>",
  },
  {
    name: "03-multipart-alternative",
    subject: "[fixture] multipart alternative (text + html)",
    text: "Plain text version of the body.",
    html: "<p>This is the <em>HTML</em> version of the body.</p>",
  },
  {
    name: "04-with-png-attachment",
    subject: "[fixture] with PNG attachment",
    text: "Body with an attached 1x1 png.",
    attachments: [
      { filename: "pixel.png", content: PIXEL_PNG_B64, content_type: "image/png" },
    ],
  },
  {
    name: "05-with-text-attachment",
    subject: "[fixture] with text attachment",
    text: "Body with an attached text file.",
    attachments: [
      { filename: "notes.txt", content: TEXT_FILE_B64, content_type: "text/plain" },
    ],
  },
  {
    name: "06-multiple-attachments",
    subject: "[fixture] two attachments",
    text: "Body with two attachments of different types.",
    attachments: [
      { filename: "pixel.png", content: PIXEL_PNG_B64, content_type: "image/png" },
      { filename: "notes.txt", content: TEXT_FILE_B64, content_type: "text/plain" },
    ],
  },
  {
    name: "07-unicode-subject-and-body",
    subject: "[fixture] unicode 🌍 — café résumé naïve",
    text: "Body with non-ASCII content: 日本語 русский عربى 🚀\nLine two with emoji 🎉.",
    html: "<p>Body with non-ASCII content: 日本語 русский عربى 🚀<br>Line two with emoji 🎉.</p>",
  },
  {
    name: "08-cc-and-reply-to",
    subject: "[fixture] cc + reply-to",
    text: "Body — check the headers.",
    cc: ["porkytheblack+cc@gmail.com"],
    reply_to: ["replyto-test@example.com"],
  },
  {
    name: "09-custom-headers",
    subject: "[fixture] custom X- headers",
    text: "Body. Should have a couple of X-Test-* headers preserved.",
    headers: {
      "X-Test-Foo": "bar-baz",
      "X-Test-Multi": "first-value",
    },
  },
  {
    name: "10-long-body",
    subject: "[fixture] long body (preview should truncate at 240)",
    text: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(40),
  },
  {
    name: "11-inline-image-html",
    subject: "[fixture] inline image referenced via cid:",
    html: "<p>Inline image below:</p><p><img src=\"cid:pixel-cid-001\" alt=\"pixel\"></p><p>End.</p>",
    attachments: [
      {
        filename: "pixel.png",
        content: PIXEL_PNG_B64,
        content_type: "image/png",
        content_id: "pixel-cid-001",
      },
    ],
  },
  {
    name: "12-empty-text-body",
    subject: "[fixture] effectively empty body",
    text: " ",
  },
]

const DELAY_MS = 5000

const send = async (
  apiKey: string,
  from: string,
  to: string,
  fix: Fixture,
): Promise<{ id: string }> => {
  const body: Record<string, unknown> = {
    from,
    to: [to],
    subject: fix.subject,
  }
  if (fix.text) body.text = fix.text
  if (fix.html) body.html = fix.html
  if (fix.cc) body.cc = fix.cc
  if (fix.bcc) body.bcc = fix.bcc
  if (fix.reply_to) body.reply_to = fix.reply_to
  if (fix.headers) body.headers = fix.headers
  if (fix.attachments) body.attachments = fix.attachments

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })

  const txt = await r.text()
  if (!r.ok) {
    throw new Error(`resend ${r.status}: ${txt}`)
  }
  return JSON.parse(txt) as { id: string }
}

const main = async () => {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM
  const to = process.env.REGISTER_EMAIL
  const only = process.env.FIXTURE_ONLY  // optional: comma-separated substrings, e.g. "01,02,03"

  const missing: string[] = []
  if (!apiKey) missing.push("RESEND_API_KEY")
  if (!from) missing.push("RESEND_FROM")
  if (!to) missing.push("REGISTER_EMAIL")
  if (missing.length > 0) {
    console.error("missing env:", missing.join(", "))
    console.error("RESEND_FROM example: 'Mail Station Tests <tests@your-verified-domain.com>'")
    process.exit(1)
  }

  const filters = only ? only.split(",").map((s) => s.trim()).filter(Boolean) : null
  const selected = filters
    ? FIXTURES.filter((f) => filters.some((q) => f.name.includes(q)))
    : FIXTURES

  if (selected.length === 0) {
    console.error(`no fixtures matched FIXTURE_ONLY="${only}". available:`)
    for (const f of FIXTURES) console.error(`  - ${f.name}`)
    process.exit(1)
  }

  console.log(`[fixtures] sending ${selected.length} via Resend`)
  console.log(`[fixtures] from: ${from}`)
  console.log(`[fixtures] to:   ${to}`)
  console.log(`[fixtures] gap:  ${DELAY_MS}ms between sends`)
  console.log()

  for (let i = 0; i < selected.length; i++) {
    const f = selected[i]!
    try {
      const out = await send(apiKey!, from!, to!, f)
      console.log(`[send] ${f.name.padEnd(28)} resend.id=${out.id}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[send] ${f.name.padEnd(28)} FAILED: ${msg}`)
    }
    if (i < selected.length - 1) await new Promise((r) => setTimeout(r, DELAY_MS))
  }

  console.log()
  console.log("[fixtures] done. watch the gmail-e2e log for handler output.")
}

main().catch((e) => {
  console.error("[fatal]", e)
  process.exit(1)
})
