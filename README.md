# Databricks Apps — CI/CD demo

End-to-end CI/CD reference for a Databricks Apps chatbot that uses **on-behalf-of-user (OBO) authorization**, an **Agent Bricks / Foundation Model serving endpoint**, and **Lakebase** for persistent chat history. Forked and customised from `databricks/app-templates/e2e-chatbot-app-next`.

The point of this repo is the **pipeline shape**, not the chat app itself. Use it as a template platform teams can copy and adapt to their own apps.

---

## What this demonstrates

| Capability | How |
|---|---|
| **OBO** | `user_api_scopes` in `databricks.yml` lets the app call the agent endpoint and Lakebase as the signed-in user — UC permissions enforced |
| **Agent Bricks** | App calls a `serving_endpoint` (default `databricks-claude-sonnet-4` — swap for a custom Agent Bricks endpoint) |
| **Lakebase** | Managed Postgres provisioned by the bundle; chat history persists across deployments and rollbacks. (See [Lakebase Autoscaling note](#a-note-on-lakebase-autoscaling) below.) |
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

### 3. Configure GitHub Environments + secrets

In repo Settings → Environments, create three environments: `dev`, `staging`, `prod`.

In **each** environment, add the same three secret names with that environment's values:

| Secret | Value |
|---|---|
| `DATABRICKS_HOST` | workspace URL (e.g. `https://adb-7405617428812971.11.azuredatabricks.net`) |
| `DATABRICKS_CLIENT_ID` | the matching SP's client id (dev SP for `dev`, staging SP for `staging`, etc.) |
| `DATABRICKS_CLIENT_SECRET` | the matching SP's client secret |

The workflows reference `secrets.DATABRICKS_CLIENT_ID` and pair it with `environment: <name>` — GitHub resolves the value from whichever environment the job is running in. This keeps each SP's creds scoped to its own environment (better audit, easier rotation) without any per-environment naming in the YAML.

### 4. Configure approvals

Still in repo Settings → Environments, on the `prod` environment add **required reviewers** so the prod deploy step pauses for human approval. `dev` and `staging` should have no protection rules — they need to deploy unattended.

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

> **Heads up — concurrency:** `release.yml` and `rollback.yml` share a `prod-deploy` lock so the two can never deploy to prod at the same time. `release.yml` additionally serializes the whole pipeline under `release-pipeline`. Practical effect: if a release is paused on prod approval and you push a hotfix tag, the hotfix run is **queued** behind the in-flight one. To unblock, either approve the pending prod deploy or cancel the in-flight workflow run from the Actions UI.

## Rollback strategy

There is no native one-click rollback in Databricks Apps — both rollback paths re-deploy older code through the same pipeline. This repo implements both:

| Path | When to use | Mechanism |
|---|---|---|
| **`workflow_dispatch` re-deploy** (primary) | Any rollback, urgent or planned | `rollback.yml` checks out the target tag, runs `bundle deploy + bundle run` against prod |
| **Revert PR on `main`** (follow-up) | Trunk hygiene after a rollback | Open a "Revert <bad PR>" PR; flows through dev → staging → prod normally so `main` HEAD = what's running |

**Why `workflow_dispatch` is primary** (and not just break-glass): it's what [Databricks officially recommends](https://docs.databricks.com/aws/en/dev-tools/ci-cd/best-practices), it preserves the prod approval gate, and it's faster than waiting for a revert PR to traverse the full pipeline. The revert PR is the *trunk-hygiene step*, not the rollback itself.

**Traceability:** `databricks apps list-deployments` returns server-generated 32-char hex deployment IDs (e.g. `01f1453256c510d39e9d369944ae2073`) — opaque and not human-readable. Map deployments to releases via:

1. **App header** — the running app shows its `git_sha` + `git_ref` (injected as env vars by the workflows). Most user-visible.
2. **Audit log** — `system.access.audit` rows where `service_name = 'apps'` show who, when, and which workspace path was deployed (deploy/permission action_names appear there — verify exact names in your workspace).
3. **Git tags** — every prod release is tagged; the tag is the human-readable name. Pair tag + deployment `create_time` from the audit log to identify a deployment_id.

### Data-side rollback (Lakebase)

App rollback covers code only. A schema migration applied by the bad release is **not** undone by re-deploying old code. For destructive changes:

1. **Before the migration:** create a Lakebase branch (instant copy-on-write — see [Lakebase branching](https://www.databricks.com/blog/database-branching-postgres-git-style-workflows-databricks-lakebase))
2. **If rollback needed:** restore from the branch (single API call)
3. **If successful:** keep the branch 48–72h as a safety net, then drop

Always write **forward-compatible migrations** (add nullable column → dual-write → drop old column in a separate release) so a code rollback never requires a schema rollback.

## Local development

```bash
npm ci
cp .env.example .env       # set DATABRICKS_CONFIG_PROFILE=demo
npm run dev                # client on 3000, server on 3001
```

To run against a local Lakebase mirror, see `UPSTREAM_README.md` (preserved from the upstream template) — covers `quickstart.sh`, `migrate.ts`, etc.

## Useful commands during the demo

```bash
# History of every deployment, newest first
databricks apps list-deployments db-chatbot-prod --output json \
  | jq '.[0:5] | .[] | {deployment_id, status, creator, create_time, source_code_path}'

# What's running right now
databricks apps get db-chatbot-prod
```

Audit-log who deployed / changed permissions on apps (run in a SQL editor against
the workspace, or via the Statement Execution API):

```sql
SELECT event_time, user_identity.email, action_name, request_params
FROM system.access.audit
WHERE service_name = 'apps'
ORDER BY event_time DESC LIMIT 20
```

## A note on Lakebase Autoscaling

The bundle defines the database via the legacy `database_instances` resource and the legacy `app.resources.database` binding. **You still get Lakebase Autoscaling** — Databricks transparently provisions any new `database_instances` as a `postgres_projects` (with autoscaling compute, scale-to-zero, branching, and 7-day instant restore). You can confirm with `databricks postgres list-projects`.

A native migration (using `postgres_projects` + `postgres_branches` + `postgres_endpoints` directly, plus `app.resources.postgres`) was scoped but is currently blocked: the `app.resources.postgres.database` field requires a database resource id that's auto-generated by the platform, and the `databricks_postgres_database` Terraform resource that would let us create one with a known id is still in Private Preview and not yet exposed in DABs. Once `postgres_databases` lands in DABs, this template will switch to the native syntax — see [the Manage Lakebase with DABs docs](https://learn.microsoft.com/en-us/azure/databricks/oltp/projects/manage-with-bundles) for the eventual shape.

In the meantime: the legacy syntax is the right answer, and `bundle destroy` removes the app + database instance together.

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
