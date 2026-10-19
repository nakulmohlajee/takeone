#!/usr/bin/env bash
# Warm virtual-background (RVM matting) service from the worker image: one instance always on,
# CPU not throttled, so matte jobs start instantly. Private; the API service account invokes it.
#   ./scripts/deploy-matte-service.sh            (after ./scripts/deploy-worker-job.sh built the image)
set -euo pipefail
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-takeone-matte}"
IMAGE_URI="${IMAGE_URI:-${REGION}-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy/takeone-worker:latest}"
GCS_BUCKET="${GCS_BUCKET:-takeone-media-vault-${PROJECT_ID}}"
MIN_INSTANCES="${MIN_INSTANCES:-0}"

gcloud run deploy "${SERVICE}" \
  --project="${PROJECT_ID}" --region="${REGION}" --image="${IMAGE_URI}" \
  --command=node --args=dist-worker/worker.mjs,--kind=serve \
  --cpu=8 --memory=8Gi --no-cpu-throttling --execution-environment=gen2 \
  --min-instances="${MIN_INSTANCES}" --max-instances=2 --concurrency=4 --timeout=900 \
  --no-allow-unauthenticated \
  --set-env-vars="NODE_ENV=production,GCS_BUCKET=${GCS_BUCKET},GOOGLE_CLOUD_PROJECT=${PROJECT_ID},MATTE_LANES=1,MATTE_THREADS=4" \
  --quiet

URL=$(gcloud run services describe "${SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)')
API_SA=$(gcloud run services describe takeone --project="${PROJECT_ID}" --region="${REGION}" --format='value(spec.template.spec.serviceAccountName)')
API_SA="${API_SA:-$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')-compute@developer.gserviceaccount.com}"
gcloud run services add-iam-policy-binding "${SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" \
  --member="serviceAccount:${API_SA}" --role=roles/run.invoker --quiet >/dev/null
gcloud run services update takeone --project="${PROJECT_ID}" --region="${REGION}" \
  --update-env-vars="MATTE_SERVICE_URL=${URL}" --quiet
echo "Matte service: ${URL} (invoker: ${API_SA}). Turn it off after judging: MIN_INSTANCES=0 $0"
