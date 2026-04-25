#!/usr/bin/env bash
# Idempotent GCP-side setup for the gmail-e2e example.
#
# Reads GCP_PROJECT_ID, PUBSUB_TOPIC, PUBSUB_SUBSCRIPTION from .env,
# then provisions:
#   - Gmail API + Pub/Sub API enabled on the project
#   - The Pub/Sub topic (idempotent)
#   - Publisher grant for gmail-api-push@system.gserviceaccount.com on the topic
#   - The pull subscription (idempotent)
#
# Re-runnable. Skips work that's already done.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "error: .env not found at $(pwd)/.env"
  echo "       cp .env.example .env, fill it in, and re-run"
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

require() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "error: $name is empty in .env"
    exit 1
  fi
}

require GCP_PROJECT_ID
require PUBSUB_TOPIC
require PUBSUB_SUBSCRIPTION

# Strip "projects/<id>/topics/" -> bare name. gcloud commands take bare names + --project.
topic_name="${PUBSUB_TOPIC##*/}"
sub_name="${PUBSUB_SUBSCRIPTION##*/}"

echo "[setup-gcp] project:        $GCP_PROJECT_ID"
echo "[setup-gcp] topic:          $topic_name"
echo "[setup-gcp] subscription:   $sub_name"

echo "[setup-gcp] enabling APIs (gmail, pubsub) ..."
gcloud services enable gmail.googleapis.com pubsub.googleapis.com \
  --project="$GCP_PROJECT_ID" --quiet

echo "[setup-gcp] ensuring topic exists ..."
if gcloud pubsub topics describe "$topic_name" --project="$GCP_PROJECT_ID" >/dev/null 2>&1; then
  echo "[setup-gcp]   topic already exists"
else
  gcloud pubsub topics create "$topic_name" --project="$GCP_PROJECT_ID" --quiet
  echo "[setup-gcp]   topic created"
fi

echo "[setup-gcp] granting Publisher to gmail-api-push@system.gserviceaccount.com ..."
gcloud pubsub topics add-iam-policy-binding "$topic_name" \
  --project="$GCP_PROJECT_ID" \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher" --quiet >/dev/null

echo "[setup-gcp] ensuring pull subscription exists ..."
if gcloud pubsub subscriptions describe "$sub_name" --project="$GCP_PROJECT_ID" >/dev/null 2>&1; then
  echo "[setup-gcp]   subscription already exists"
else
  gcloud pubsub subscriptions create "$sub_name" \
    --topic="$topic_name" \
    --project="$GCP_PROJECT_ID" \
    --ack-deadline=30 \
    --quiet
  echo "[setup-gcp]   subscription created"
fi

echo
echo "[setup-gcp] done."
echo "next:"
echo "  - if you haven't yet:  gcloud auth application-default login"
echo "  - then:                pnpm --filter gmail-e2e-example start"
