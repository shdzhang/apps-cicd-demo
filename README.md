# Databricks Apps — CI/CD demo

End-to-end CI/CD reference for a Databricks Apps chatbot that uses **on-behalf-of-user (OBO) authorization**, an **Agent Bricks / Foundation Model serving endpoint**, and **Lakebase** for persistent chat history. Forked and customised from `databricks/app-templates/e2e-chatbot-app-next`.

The point of this repo is the **pipeline shape**, not the chat app itself. Use it as a template platform teams can copy and adapt to their own apps.

---

## What this demonstrates

| Capability | How |
|---|---|
| **OBO** | `user_api_scopes` in `databricks.yml` lets the app call the agent endpoint and Lakebase as the signed-in user — UC permissions enforced |
| **Agent Bricks** | App calls a `serving_endpoint` (default `databricks-claude-sonnet-4` — swap for a custom Agent Bricks endpoint) |
| **Lakebase** | Managed Postgres provisioned by the bundle; chat history persists across deployments and rollbacks |
| **DABs lifecycle** | One `databricks.yml`, three targets (`dev` / `staging` / `prod`), parameterised by suffix |
| **Versioning** | Git SHA + ref injected as env vars, surfaced in the app header |
| **CI gates** | PR validation, automatic dev deploy, tag-driven staging→prod release with approval |
| **Rollback** | `workflow_dispatch` action that re-deploys an older Git tag through the same pipeline |
| **Audit** | `databricks apps list-deployments` after each pipeline step; `system.access.audit` for sharing/permission events |

## Pipeline overview

```
                                  ┌─────────────┐
                  PR open ───────►│ validate.yml│  lint + typecheck + bundle validate
                                  └─────────────┘
                                          │
                  Merge to main ──────────┴───────►┌──────────────┐
                                                   │deploy-dev.yml│  bundle deploy + run @ dev
                                                   └──────────────┘

                                                   ┌──────────────┐
                  Push tag v* ─────────────────────►│ release.yml  │  staging → manual approval → prod
                                                   └──────────────┘

                  Manual rollback ─────────────────►┌──────────────┐
                  (workflow_dispatch + tag input)   │ rollback.yml │  re-deploy older tag to prod
                                                   └──────────────┘
```

## Repo layout

```
.
├── .github/workflows/
│   ├── validate.yml       # PR + non-main pushes — lint, typecheck, bundle validate
│   ├── deploy-dev.yml     # main pushes — deploy + run @ dev
│   ├── release.yml        # tag v* — staging → prod with approval gate
│   └── rollback.yml       # workflow_dispatch — re-deploy older tag to prod
├── databricks.yml         # DABs config, three targets, OBO scopes, Lakebase, version vars
├── app.yaml               # App runtime entrypoint
├── client/                # React + TS + Tailwind + Vercel AI SDK
├── server/                # Express + AI SDK + Drizzle
├── packages/              # Shared TS packages (core, auth, db, ai-sdk-providers)
└── tests/                 # Playwright (unit / routes / e2e)
```

## One-time setup

### 1. Authenticate to the workspace

```bash
databricks auth login --host https://adb-7405617428812971.11.azuredatabricks.net --profile demo
```

### 2. Create three service principals (one per target)

In Account Console → Service principals, create:

| SP name | Granted in workspace | Purpose |
|---|---|---|
| `apps-cicd-dev` | workspace user; permission to deploy Apps | dev pipelines |
| `apps-cicd-staging` | workspace user; permission to deploy Apps | staging pipelines |
| `apps-cicd-prod` | workspace user; permission to deploy Apps | prod pipelines |

Generate an OAuth secret for each. Record `CLIENT_ID` / `CLIENT_SECRET` per SP.

### 3. Configure GitHub repo secrets

| Secret | Value |
|---|---|
| `DATABRICKS_HOST` | `https://adb-7405617428812971.11.azuredatabricks.net` |
| `DATABRICKS_DEV_CLIENT_ID` | dev SP client id |
| `DATABRICKS_DEV_CLIENT_SECRET` | dev SP client secret |
| `DATABRICKS_STAGING_CLIENT_ID` | staging SP client id |
| `DATABRICKS_STAGING_CLIENT_SECRET` | staging SP client secret |
| `DATABRICKS_PROD_CLIENT_ID` | prod SP client id |
| `DATABRICKS_PROD_CLIENT_SECRET` | prod SP client secret |

### 4. Configure GitHub Environments + approvals

In repo Settings → Environments, create `dev`, `staging`, `prod`. Add **required reviewers** to `prod` so the prod deploy step pauses for human approval.

### 5. First-time bundle init

```bash
npm ci
databricks bundle validate -t dev
databricks bundle deploy -t dev          # provisions Lakebase + creates app
databricks bundle run databricks_chatbot -t dev
```

The first deploy provisions a Lakebase instance — give it 5–10 minutes.

## Daily workflow

| Action | What happens |
|---|---|
| Open a PR | `validate.yml` runs lint, typecheck, `bundle validate` for all three targets |
| Merge to `main` | `deploy-dev.yml` deploys + restarts dev app |
| `git tag v1.2.0 && git push --tags` | `release.yml` deploys staging, then prompts for approval, then deploys prod |
| Need to roll back | Repo → Actions → "Rollback prod" → enter the previous tag (e.g. `v1.1.5`) and reason |

The running app shows the live build in the header (`v1.2.0` and the short SHA). Roll back, refresh — header updates instantly.

## Local development

```bash
npm ci
cp .env.example .env       # set DATABRICKS_CONFIG_PROFILE=demo
npm run dev                # client on 3000, server on 3001
```

To run against a local Lakebase mirror, see `UPSTREAM_README.md` (preserved from the upstream template) — covers `quickstart.sh`, `migrate.ts`, etc.

## Useful CLI commands during the demo

```bash
# History of every deployment, newest first
databricks apps list-deployments db-chatbot-prod --output json | jq '.deployments[0:5]'

# What's running right now
databricks apps get db-chatbot-prod

# Audit-log who changed app permissions
databricks sql execute --warehouse <wh> --query "
  SELECT event_date, user_identity.email, action_name, request_params.request_object_id
  FROM system.access.audit
  WHERE action_name LIKE 'changeAppsAcl' OR action_name LIKE '%AppDeployment%'
  ORDER BY event_date DESC LIMIT 20"
```

## Customising for your app

- **Different agent endpoint:** change `var.serving_endpoint_name` (or set per-target in `databricks.yml`)
- **Different OBO scopes:** edit `user_api_scopes` in `databricks.yml`
- **Different account groups for permissions:** edit `var.app_users_group` / `var.app_admins_group`
- **More targets:** add another `targets:` block (e.g. `qa`) — workflows can be parameterised similarly

## References

- [Databricks Apps in DABs](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/bundles/apps)
- [Configure authorization in a Databricks app (OBO)](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/databricks-apps/auth)
- [Apps networking](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/databricks-apps/networking)
- [DABs CI/CD best practices](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/ci-cd/best-practices)
- Original template: [databricks/app-templates `e2e-chatbot-app-next`](https://github.com/databricks/app-templates/tree/main/e2e-chatbot-app-next)
