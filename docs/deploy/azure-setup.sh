#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# One-time Azure provisioning for the lowest-cost deployment described in
# docs/deploy/README.md (docs/DECISIONS.md D-091). Run this ONCE, locally,
# after `az login`. It is not part of CI - GitHub Actions only updates the
# container image on an already-provisioned Container App
# (.github/workflows/deploy-backend.yml / deploy-optimizer.yml).
#
# Safe to re-run: every `az ... create` below uses a name that already
# existing resources would collide with, so Azure either no-ops or errors
# loudly rather than duplicating anything - but it is written as a
# run-top-to-bottom script, not a template to copy-paste piecemeal.
#
# Prerequisites:
#   - az CLI installed and `az login` already run
#   - A GitHub PAT (classic) with `read:packages` scope, so the private
#     ghcr.io images this repo pushes can be pulled by Container Apps.
#     Create one at https://github.com/settings/tokens, export it below.
# ---------------------------------------------------------------------------
set -euo pipefail

# --- Fill these in -----------------------------------------------------------
RESOURCE_GROUP="railway-blockplan-rg"
LOCATION="centralindia"          # pick the region closest to your judges/demo
ENV_NAME="railway-blockplan-env"
BACKEND_APP="railway-backend"
OPTIMIZER_APP="railway-optimizer"
GITHUB_ORG="aroy2o"
GITHUB_REPO="railway"
GHCR_USERNAME="aroy2o"           # your GitHub username
GHCR_PAT="${GHCR_PAT:?export GHCR_PAT=<your read:packages PAT> before running}"

# Secrets - do NOT commit real values. Export these in your shell before
# running, or the script will fall back to obviously-fake dev values that
# will not work.
MONGODB_URI="${MONGODB_URI:-mongodb+srv://REPLACE_ME}"
JWT_SECRET="${JWT_SECRET:-$(openssl rand -hex 32)}"
GROQ_API_KEY="${GROQ_API_KEY:-}"

echo "== 1. Resource group =="
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

echo "== 2. Container Apps environment (includes a free-tier Log Analytics workspace) =="
az containerapp env create \
  --name "$ENV_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --output none

echo "== 3. Azure AD app registration + OIDC federated credential for GitHub Actions =="
# This lets GitHub Actions authenticate to Azure with no stored client
# secret - only client-id/tenant-id/subscription-id, which are not secret
# in the same way a password is (still stored as repo secrets by convention).
APP_ID=$(az ad app create --display-name "railway-blockplan-gh-actions" --query appId -o tsv)
az ad sp create --id "$APP_ID" --output none 2>/dev/null || true

az ad app federated-credential create \
  --id "$APP_ID" \
  --parameters "{
    \"name\": \"github-main-branch\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"repo:${GITHUB_ORG}/${GITHUB_REPO}:ref:refs/heads/main\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }"

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)

az role assignment create \
  --assignee "$APP_ID" \
  --role "Contributor" \
  --scope "/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}" \
  --output none

echo "== 4. Backend Container App (placeholder image - CI takes over from here) =="
az containerapp create \
  --name "$BACKEND_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$ENV_NAME" \
  --image "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest" \
  --target-port 5000 \
  --ingress external \
  --min-replicas 0 \
  --max-replicas 1 \
  --cpu 0.25 --memory 0.5Gi \
  --registry-server ghcr.io \
  --registry-username "$GHCR_USERNAME" \
  --registry-password "$GHCR_PAT" \
  --secrets "mongodb-uri=${MONGODB_URI}" "jwt-secret=${JWT_SECRET}" "groq-api-key=${GROQ_API_KEY}" \
  --env-vars \
    "NODE_ENV=production" \
    "BACKEND_PORT=5000" \
    "MONGODB_URI=secretref:mongodb-uri" \
    "JWT_SECRET=secretref:jwt-secret" \
    "JWT_EXPIRES_IN=12h" \
    "OPTIMIZER_URL=https://${OPTIMIZER_APP}.internal.$(az containerapp env show -n "$ENV_NAME" -g "$RESOURCE_GROUP" --query 'properties.defaultDomain' -o tsv)" \
    "OPTIMIZER_TIMEOUT_MS=30000" \
    "LLM_PROVIDER=groq" \
    "GROQ_API_KEY=secretref:groq-api-key" \
    "GROQ_MODEL=openai/gpt-oss-120b" \
  --output none

echo "== 5. Optimizer Container App (placeholder image - CI takes over from here) =="
az containerapp create \
  --name "$OPTIMIZER_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$ENV_NAME" \
  --image "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest" \
  --target-port 8000 \
  --ingress internal \
  --min-replicas 0 \
  --max-replicas 1 \
  --cpu 0.5 --memory 1.0Gi \
  --registry-server ghcr.io \
  --registry-username "$GHCR_USERNAME" \
  --registry-password "$GHCR_PAT" \
  --env-vars \
    "OPTIMIZER_HOST=0.0.0.0" \
    "OPTIMIZER_PORT=8000" \
    "SOLVER_MAX_SECONDS=10" \
    "SOLVER_NUM_WORKERS=0" \
  --output none

BACKEND_FQDN=$(az containerapp show -n "$BACKEND_APP" -g "$RESOURCE_GROUP" --query 'properties.configuration.ingress.fqdn' -o tsv)

echo "== 6. Budget alert (belt-and-braces - emails you the moment ANY spend posts) =="
# Cost is expected to be Rs.0 (see docs/deploy/README.md), so a Rs.1 threshold
# fires on the first sign of real usage rather than waiting for a bill.
BUDGET_ALERT_EMAIL="${BUDGET_ALERT_EMAIL:-abhijeetrou123@gmail.com}"
az consumption budget create \
  --budget-name "railway-blockplan-zero-cost-guard" \
  --category cost \
  --amount 1 \
  --time-grain monthly \
  --start-date "$(date +%Y-%m-01)" \
  --end-date "$(date -d '+1 year' +%Y-%m-01 2>/dev/null || date -v+1y +%Y-%m-01)" \
  --resource-group "$RESOURCE_GROUP" \
  --notifications "{
    \"Actual_GreaterThan_80_Percent\": {
      \"enabled\": true,
      \"operator\": \"GreaterThan\",
      \"threshold\": 80,
      \"contactEmails\": [\"${BUDGET_ALERT_EMAIL}\"],
      \"thresholdType\": \"Actual\"
    }
  }" \
  --output none || echo "  (budget create failed/unsupported on this subscription type - set one manually in Cost Management > Budgets instead)"

echo ""
echo "=============================================================================="
echo "Provisioning done. Next steps (see docs/deploy/README.md for full detail):"
echo ""
echo "1. Add these as GitHub Actions secrets (repo Settings > Secrets and variables"
echo "   > Actions > Secrets):"
echo "     AZURE_CLIENT_ID       = ${APP_ID}"
echo "     AZURE_TENANT_ID       = ${TENANT_ID}"
echo "     AZURE_SUBSCRIPTION_ID = ${SUBSCRIPTION_ID}"
echo ""
echo "2. Add these as GitHub Actions variables (same page, 'Variables' tab):"
echo "     AZURE_RESOURCE_GROUP     = ${RESOURCE_GROUP}"
echo "     AZURE_BACKEND_APP_NAME   = ${BACKEND_APP}"
echo "     AZURE_OPTIMIZER_APP_NAME = ${OPTIMIZER_APP}"
echo ""
echo "3. Backend is reachable at: https://${BACKEND_FQDN}"
echo "   (optimizer has --ingress internal - not publicly reachable, only the"
echo "   backend can call it, matching CLAUDE.md's 'never call OR-Tools"
echo "   directly from Node/frontend' rule)"
echo ""
echo "4. Push to main (or re-run the deploy-backend/deploy-optimizer workflows"
echo "   manually) to replace the placeholder image with your real one."
echo ""
echo "5. On Vercel (frontend): set root directory to 'frontend', build command"
echo "   'npm run build', output directory 'dist', and add these project env vars:"
echo "     VITE_API_BASE_URL     = https://${BACKEND_FQDN}/api"
echo "     VITE_PROTOTYPE_BANNER = (copy the value from .env.example)"
echo "   Then update the backend's CORS_ORIGIN secret to your Vercel domain -"
echo "   see docs/deploy/README.md step 5."
echo "=============================================================================="
