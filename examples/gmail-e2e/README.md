# gmail-e2e example

End-to-end exerciser for `mailbox-station` + `gmail-station` against a real Google account.

It registers a Gmail account, opens a watch, pulls Pub/Sub notifications, fetches new messages, and prints them through a registered handler.

## What you need

1. A **GCP project** with the Gmail API enabled.
2. An **OAuth 2.0 client** in that project (Web or Desktop both work) — gives you `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
3. A **Pub/Sub topic** and a **pull-type subscription** on that topic. The topic must grant `gmail-api-push@system.gserviceaccount.com` the `roles/pubsub.publisher` role (one-time, otherwise `users.watch` fails).
4. **Application Default Credentials** that can subscribe to the subscription. Either:
   - `gcloud auth application-default login` (developer laptop), or
   - `export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json` (a service account with `roles/pubsub.subscriber` on the subscription).
5. A **refresh token** for the gmail account you want to watch. Mint it via your own OAuth flow, requesting:
   - scope: `https://www.googleapis.com/auth/gmail.readonly` (or `gmail.modify`)
   - `access_type=offline`
   - `prompt=consent`

## Run

```sh
cp .env.example .env                          # already done if you ran setup
# fill in GOOGLE_CLIENT_ID / SECRET / GCP_PROJECT_ID / PUBSUB_TOPIC / PUBSUB_SUBSCRIPTION / REGISTER_EMAIL / REFRESH_TOKEN
pnpm install                                  # from repo root, if you haven't
pnpm --filter gmail-e2e-example setup:gcp     # idempotent; provisions topic + subscription + IAM
gcloud auth application-default login         # one-time, so the Pub/Sub SDK can authenticate
pnpm --filter gmail-e2e-example start
```

The `setup:gcp` step is idempotent — re-running is safe. It enables the Gmail and Pub/Sub APIs, creates the topic and subscription if missing, and grants `gmail-api-push@system.gserviceaccount.com` the Publisher role on the topic (which Gmail needs in order to publish notifications). If you've already done this in your project, the script will detect it and no-op.

You should see:

```
[boot] starting gmail-e2e
[boot]   project:      ...
[boot]   topic:        projects/.../topics/...
...
[register] ok — accountId=...
[ready] watching for new mail. send an email to: you@example.com
```

Send a test email to `REGISTER_EMAIL`. Within a few seconds you'll see internal events from the station logger (`account.registered`, `event.received`, `event.committed`, `trigger.claimed`) followed by a `[handler] new message` block printing the parsed message.

## Stop

`Ctrl+C`. The station drains in-flight work, closes the Pub/Sub stream, and closes the SQLite database.

## Re-running

`createAccount` is unique on `(provider, emailAddress)` — re-running with the same `REGISTER_EMAIL` returns `DuplicateAccount`, which the script tolerates and continues. To start fully clean, delete the sqlite file:

```sh
rm e2e.db
```

## Watch renewal

Gmail watches expire after 7 days. This script does not schedule renewal — for a long-running deployment you'd call `station.providers.gmail.renewExpiringWatches()` daily from your own scheduler. For an interactive E2E session that's usually not relevant.
