#!/usr/bin/env bash
# One-time IAM setup for chat.flopbut.pl in GCP project flopbut.
# Run by the project owner. Idempotent: safe to run again.
#
# What it does:
#   1. Runtime account chat-runtime: read/write RTDB, set custom claims in Firebase Auth.
#   2. Deployer account chat-deployer: push images, deploy Cloud Run, act as chat-runtime,
#      publish the RTDB rules.
#   3. Workload Identity Federation so GitHub Actions in Flopsstuff/chat.flopbut.pl can
#      impersonate chat-deployer without a JSON key.
#   4. Public access to the Cloud Run service (it is a website; access is decided by the app).
#   5. Secret Manager for the bot's API keys and its Telegram bot: chat-runtime may read the
#      secrets listed below, and nothing else. The secret values themselves are added by hand,
#      never by this script.
#   6. The knowledge base's bucket, private: chat-runtime may only read it. Its files are pushed
#      by the owner with scripts/kb-push.sh.
set -euo pipefail

PROJECT=flopbut
PROJECT_NUMBER=647538737053
REGION=europe-west1
REPO=Flopsstuff/chat.flopbut.pl
RT="chat-runtime@$PROJECT.iam.gserviceaccount.com"
DP="chat-deployer@$PROJECT.iam.gserviceaccount.com"
KB_BUCKET=flopbut-kb
POOL=github
PROVIDER=github

echo "1. runtime roles"
for ROLE in roles/firebasedatabase.admin roles/firebaseauth.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member "serviceAccount:$RT" --role "$ROLE" --condition None --format none
done

echo "2. deployer roles"
for ROLE in roles/run.developer roles/firebasedatabase.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member "serviceAccount:$DP" --role "$ROLE" --condition None --format none
done
gcloud artifacts repositories add-iam-policy-binding chat --location "$REGION" --project "$PROJECT" \
  --member "serviceAccount:$DP" --role roles/artifactregistry.writer --format none
gcloud iam service-accounts add-iam-policy-binding "$RT" --project "$PROJECT" \
  --member "serviceAccount:$DP" --role roles/iam.serviceAccountUser --format none

echo "3. workload identity federation"
gcloud iam workload-identity-pools describe "$POOL" --location global --project "$PROJECT" \
  >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create "$POOL" --location global --project "$PROJECT" \
    --display-name "GitHub Actions"
gcloud iam workload-identity-pools providers describe "$PROVIDER" --location global \
  --workload-identity-pool "$POOL" --project "$PROJECT" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --location global \
    --workload-identity-pool "$POOL" --project "$PROJECT" \
    --display-name "GitHub" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.repository == '$REPO' && assertion.ref == 'refs/heads/main'"
gcloud iam service-accounts add-iam-policy-binding "$DP" --project "$PROJECT" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository/$REPO" \
  --format none

echo "4. public access to the service"
gcloud run services add-iam-policy-binding chat --region "$REGION" --project "$PROJECT" \
  --member allUsers --role roles/run.invoker --format none

echo "5. bot secrets (the model keys, and the Telegram bot that asks Flop)"
gcloud services enable secretmanager.googleapis.com --project "$PROJECT"
for SECRET in openrouter-api-key anthropic-api-key openai-api-key \
  telegram-bot-token telegram-webhook-secret; do
  if gcloud secrets describe "$SECRET" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud secrets add-iam-policy-binding "$SECRET" --project "$PROJECT" \
      --member "serviceAccount:$RT" --role roles/secretmanager.secretAccessor --format none
  else
    echo "  $SECRET does not exist yet. If the bot is to use it, create it and run this again:"
    echo "  printf '%s' \"\$KEY\" | gcloud secrets create $SECRET --project $PROJECT \\"
    echo "    --replication-policy user-managed --locations $REGION --data-file=-"
  fi
done

echo "6. knowledge base bucket"
gcloud storage buckets describe "gs://$KB_BUCKET" --project "$PROJECT" >/dev/null 2>&1 ||
  gcloud storage buckets create "gs://$KB_BUCKET" --project "$PROJECT" --location "$REGION" \
    --default-storage-class STANDARD --uniform-bucket-level-access --public-access-prevention
# Private whether this run created it or not: a bucket made by hand, or opened since, is closed.
gcloud storage buckets update "gs://$KB_BUCKET" --project "$PROJECT" \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets add-iam-policy-binding "gs://$KB_BUCKET" \
  --member "serviceAccount:$RT" --role roles/storage.objectViewer --format none

echo
echo "GitHub repository variables:"
echo "  GCP_WIF_PROVIDER=projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"
echo "  GCP_DEPLOY_SA=$DP"
