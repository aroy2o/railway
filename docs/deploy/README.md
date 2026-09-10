# Deploying for the SIH final-round demo

**Architecture** (docs/DECISIONS.md D-091): Vercel (frontend, free Hobby
plan) + Azure Container Apps (backend + optimizer, scale-to-zero) + MongoDB
Atlas M0 (free). Expected cost: **Rs.0/month** at demo-scale traffic
(estimated max ~50 users) - see the cost table in D-091 for the math.

None of this is provisioned yet. Nothing in this repo talks to Azure or
Vercel until you run the steps below yourself - I do not have your Azure
or Vercel credentials and cannot run `az`/`vercel` on your behalf.

## Order of operations

Run these top to bottom. Later steps need FQDNs/values produced by earlier
ones.

### 1. MongoDB Atlas (free M0 cluster)

1. Create a free account at https://www.mongodb.com/cloud/atlas/register
   if you don't have one.
2. Create an M0 (free tier) cluster, any region.
3. Database Access -> add a database user (username/password auth).
4. Network Access -> add IP `0.0.0.0/0` (Container Apps' outbound IP isn't
   static without extra NAT setup this project doesn't need - acceptable
   for a hackathon prototype with no real user data; do not carry this
   into anything beyond the demo without tightening it).
5. Connect -> "Drivers" -> copy the `mongodb+srv://...` connection string.
   This is your `MONGODB_URI`.

### 2. Azure: one-time provisioning

Requires the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
and a GitHub PAT (classic, `read:packages` scope only - create at
https://github.com/settings/tokens) so Container Apps can pull the private
`ghcr.io` images this repo will push.

```bash
az login

export GHCR_PAT=ghp_xxxxxxxxxxxxxxxxxxxx        # read:packages PAT
export MONGODB_URI='mongodb+srv://user:pass@...' # from step 1
export JWT_SECRET=$(openssl rand -hex 32)
export GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxx     # optional, for /explain

bash docs/deploy/azure-setup.sh
```

This creates: a resource group, a Container Apps environment, an Azure AD
app registration with a GitHub OIDC federated credential (no client secret
stored anywhere), the backend and optimizer Container Apps (both
`min-replicas 0`, optimizer `--ingress internal` only - matches CLAUDE.md's
"Node calls the Python service over internal REST; never call OR-Tools
directly from Node" rule, extended here to mean never from the browser
either), and a Rs.1 budget alert.

**Copy the script's final output block** - it prints the exact
secrets/variables step 3 needs and the backend's public URL.

### 3. GitHub Actions secrets and variables

Repo -> Settings -> Secrets and variables -> Actions.

**Secrets** tab:
| Name | Value |
|---|---|
| `AZURE_CLIENT_ID` | from the script output |
| `AZURE_TENANT_ID` | from the script output |
| `AZURE_SUBSCRIPTION_ID` | from the script output |

**Variables** tab:
| Name | Value |
|---|---|
| `AZURE_RESOURCE_GROUP` | `railway-blockplan-rg` (or whatever you set in the script) |
| `AZURE_BACKEND_APP_NAME` | `railway-backend` |
| `AZURE_OPTIMIZER_APP_NAME` | `railway-optimizer` |

Push to `main` (or run `.github/workflows/deploy-backend.yml` /
`deploy-optimizer.yml` manually via Actions -> Run workflow) to replace the
placeholder image with your real one. The backend is now live at the FQDN
the setup script printed.

### 4. Vercel: frontend

1. https://vercel.com -> New Project -> import `aroy2o/railway`.
2. **Root Directory**: `frontend` (this repo is a monorepo - Vercel must
   not try to build the repo root).
3. Framework preset: Vite (auto-detected once root directory is set).
4. Build command: `npm run build` (already `tsc -b && vite build` per
   `frontend/package.json` - Vercel just needs the npm script name).
5. Output directory: `dist`.
6. Project -> Settings -> Environment Variables, add:
   | Name | Value |
   |---|---|
   | `VITE_API_BASE_URL` | `https://<backend-fqdn-from-step-2>/api` |
   | `VITE_PROTOTYPE_BANNER` | copy the exact string from `.env.example` |

   Vite inlines `VITE_*` vars at build time (same constraint as the
   Docker build-arg wiring in `docker-compose.yml`), so these must be set
   as Vercel *build-time* env vars, not left for runtime.
7. Deploy. Vercel gives you a `https://<project>.vercel.app` URL - this is
   your live link for the PPT.

### 5. Close the loop: CORS

The backend's `CORS_ORIGIN` only allows `http://localhost:5173` right now
(the `.env.example` default baked into the Container App in step 2). Add
the real Vercel domain:

```bash
az containerapp update \
  --name railway-backend \
  --resource-group railway-blockplan-rg \
  --set-env-vars "CORS_ORIGIN=https://<your-project>.vercel.app,http://localhost:5173"
```

Without this, the deployed frontend's API calls will fail CORS preflight
even though the backend is otherwise healthy - easy to mistake for a
broken deployment when it's actually just this one setting.

### 6. Seed the database

The backend image ships without seed data (same as local dev - seeding is
a deliberate manual step per D-087). Run it once against the live backend:

```bash
az containerapp exec \
  --name railway-backend \
  --resource-group railway-blockplan-rg \
  --command "node dist/scripts/seed.js"
```

If this fails because `data/processed/*` isn't inside the container image
(it's git-ignored, regenerated output - see D-087's note on the same
issue for docker-compose), you'll need to either bake the pipeline output
into the image at build time or mount it via Azure Files. Flagging this
now rather than letting it surface as a surprise: docker-compose solves it
with a host volume mount, which has no equivalent on Container Apps
without extra Azure Files setup. **Do this step early, not the night
before the demo**, so there's time to sort it out if it doesn't Just Work.

## Verifying it actually works

Don't trust the URLs alone - click through the golden path for real:

- [ ] `https://<backend-fqdn>/api/health` returns 200
- [ ] Vercel URL loads, shows the prototype-data banner (PRD Section 5 -
      don't let this get dropped in production the way it can't be
      dropped locally)
- [ ] Log in with a seeded demo account (see `DEMO_ACCOUNTS.md`)
- [ ] Trigger `POST /api/schedules/generate` from the real UI and confirm
      a real solved plan comes back, not a timeout or 500
- [ ] Confirm the optimizer's internal-only ingress means
      `https://<optimizer-fqdn>` is NOT reachable directly from a browser
      (should fail/refuse) - the browser must only ever reach the backend

## Ongoing cost hygiene

- Keep both Container Apps at `min-replicas: 0`. Do not raise this "just
  to avoid cold starts" without re-reading the cost table in D-091 first.
- The Rs.1 budget alert email goes to abhijeetrou123@gmail.com by default
  (`BUDGET_ALERT_EMAIL` env var in the setup script to change it).
- [Reset schedules before demo](../../.claude in memory, not this repo) -
  separately from deployment, remember `npm run seed` does not clear
  prior schedules/audit history; wipe deliberately before the actual
  pitch run, same as local dev.
