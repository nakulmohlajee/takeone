#!/usr/bin/env bash
# Build the slim worker image (Dockerfile.worker) and deploy the takeone-worker Cloud Run Job.
# Workers run: node dist-worker/worker.mjs --kind=... --id=...
#
# Prerequisites:
#   - gcloud auth and project set
#
# Example:
#   export PROJECT_ID=my-project
#   export REGION=us-central1
#   ./scripts/deploy-worker-job.sh            # builds + deploys
#   IMAGE_URI=... SKIP_BUILD=1 ./scripts/deploy-worker-job.sh

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-${CLOUD_RUN_REGION:-us-central1}}"
JOB_NAME="${JOB_NAME:-takeone-worker}"
IMAGE_URI="${IMAGE_URI:-${REGION}-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy/takeone-worker:latest}"

if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "PROJECT_ID is required" >&2
  exit 1
fi

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  gcloud builds submit \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --config=cloudbuild.worker.yaml \
    --substitutions="_IMAGE=${IMAGE_URI}" \
    .
fi

# Job task timeout should exceed MAX_RENDER_SECONDS (default 2400s / 40m).
TASK_TIMEOUT="${TASK_TIMEOUT:-3600s}"
# Billing is per vCPU-second, so 4 vCPU finishes ~2x faster at about the same cost per render.
CPU="${CPU:-4}"
MEMORY="${MEMORY:-4Gi}"
EXEC_ENV="${EXEC_ENV:-gen2}"
GCS_BUCKET="${GCS_BUCKET:-takeone-media-vault-${PROJECT_ID}}"

gcloud run jobs deploy "${JOB_NAME}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${IMAGE_URI}" \
  --task-timeout="${TASK_TIMEOUT}" \
  --cpu="${CPU}" \
  --memory="${MEMORY}" \
  --execution-environment="${EXEC_ENV}" \
  --max-retries=0 \
  --parallelism=1 \
  --tasks=1 \
  --command=node \
  --args=dist-worker/worker.mjs \
  --set-env-vars="NODE_ENV=production,GCS_BUCKET=${GCS_BUCKET},GOOGLE_CLOUD_PROJECT=${PROJECT_ID},MAX_RENDER_SECONDS=2400" \
  --set-secrets="GEMINI_API_KEY=GEMINI_API_KEY:latest,YOUTUBE_API_KEY=YOUTUBE_API_KEY:latest" \
  --quiet

echo ""
echo "Grant the API service account permission to run this job:"
echo "  gcloud run jobs add-iam-policy-binding ${JOB_NAME} \\"
echo "    --project=${PROJECT_ID} --region=${REGION} \\"
echo "    --member=serviceAccount:YOUR_API_SA@${PROJECT_ID}.iam.gserviceaccount.com \\"
echo "    --role=roles/run.developer"
echo ""
echo "On the Cloud Run API service, set:"
echo "  TAKEONE_WORKER_JOB=${JOB_NAME}"
echo "  CLOUD_RUN_REGION=${REGION}"
