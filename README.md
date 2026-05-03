# Databricks Apps — CI/CD demo (Git-backed variant)

End-to-end CI/CD reference for a Databricks Apps chatbot that uses **on-behalf-of-user (OBO) authorization**, an **Agent Bricks / Foundation Model serving endpoint**, and **Lakebase** for persistent chat history. Forked and customised from `databricks/app-templates/e2e-chatbot-app-next`.

This branch (`git-backed`) uses [Git-backed app deployment](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/deploy#deploy-from-a-git-repository) (GA 2026-04-21) — the platform pulls source from Git, no workspace-file upload of source code. Compare with `main`, which uploads source via `bundle deploy`.

The point of this repo is the **pipeline shape**, not the chat app itself. Use it as a template platform teams can copy and adapt to their own apps.

---

## What this demonstrates

| Capability | How |
|---|---|
| **Git-backed source** | `git_repository` + `git_source` in `databricks.yml`; CI overrides ref per-run via `apps deploy --json '{"git_source":{...}}'` |
| **OBO** | `user_api_scopes` in `databricks.yml` lets the app call the agent endpoint and Lakebase as the signed-in user — UC permissions enforced |
| **Agent Bricks** | App calls a `serving_endpoint` (default `databricks-claude-sonnet-4` — swap for a custom Agent Bricks endpoint) |
| **Lakebase** | Managed Postgres provisioned by the bundle; chat history persists across deployments and rollbacks. (See [Lakebase Autoscaling note](#a-note-on-lakebase-autoscaling) below.) |
| **DABs lifecycle** | One `databricks.yml`, three targets (`dev` / `staging` / `prod`), parameterised by suffix |
| **Versioning** | Deployment record carries `git_source.tag/branch/commit` + `resolved_commit` natively; app header reads the active deployment from the Apps API at runtime (cached 5 min) and surfaces the tag prominently — see `server/src/routes/config.ts` |
| **CI gates** | PR validation, automatic dev deploy, tag-driven staging→prod release with approval |
| **Release automation** | Optional [release-please](https://github.com/googleapis/release-please-action) workflow opens a "Release vX.Y.Z" PR per merge to `main` based on Conventional Commits — merging the PR creates the tag, which fires `release.yml` |
| **Rollback** | `workflow_dispatch` action that re-deploys an older Git tag through the same pipeline |
| **Audit** | `apps list-deployments` shows tag/branch + resolved commit per deployment; `system.access.audit` for sharing/permission events |

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
│   ├── validate.yml         # PR + non-main pushes — lint, typecheck, bundle validate
│   ├── deploy-dev.yml       # main pushes — bundle deploy + apps deploy @ dev
│   ├── release.yml          # tag v* — staging → prod with approval gate
│   ├── rollback.yml         # workflow_dispatch — re-deploy older tag to prod
│   └── release-please.yml   # main pushes — auto-bump + open release PR (optional)
├── release-please-config.json     # release-please bump rules + changelog sections
├── .release-please-manifest.json  # current version (release-please updates this)
├── databricks.yml           # DABs config, three targets, OBO scopes, Lakebase, git_repository
├── app.yaml                 # App runtime entrypoint
├── client/                  # React + TS + Tailwind + Vercel AI SDK
├── server/                  # Express + AI SDK + Drizzle
├── packages/                # Shared TS packages (core, auth, db, ai-sdk-providers)
└── tests/                   # Playwright (unit / routes / e2e)
```

## One-time setup

### 1. Authenticate to the workspace

```bash
databricks auth login --host https://<your-workspace>.cloud.databricks.com --profile demo
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
| `DATABRICKS_HOST` | workspace URL (e.g. `https://<your-workspace>.cloud.databricks.com` or your Azure equivalent) |
| `DATABRICKS_CLIENT_ID` | the matching SP's client id (dev SP for `dev`, staging SP for `staging`, etc.) |
| `DATABRICKS_CLIENT_SECRET` | the matching SP's client secret |

The workflows reference `secrets.DATABRICKS_CLIENT_ID` and pair it with `environment: <name>` — GitHub resolves the value from whichever environment the job is running in. This keeps each SP's creds scoped to its own environment (better audit, easier rotation) without any per-environment naming in the YAML.

### 4. Configure approvals

Still in repo Settings → Environments, on the `prod` environment add **required reviewers** so the prod deploy step pauses for human approval. `dev` and `staging` should have no protection rules — they need to deploy unattended.

### 5. Configure Git credentials on each app's service principal

Git-backed app deploy requires the **app's auto-created service principal** to have a Git credential — the user-level Git credential in User Settings doesn't transfer. For private repos this is mandatory; public repos skip this step.

```bash
# After the first `bundle deploy -t <target>`, find the app's SP id
databricks apps get db-chatbot-<suffix> --output json | jq '.service_principal_id'

# Generate a fine-grained GitHub PAT scoped to this repo with Contents: Read-only
# (https://github.com/settings/personal-access-tokens/new). Then attach it:
databricks git-credentials create gitHub \
  --principal-id <SP_ID> \
  --git-username <YOUR_GH_USERNAME> \
  --git-email <YOUR_EMAIL> \
  --personal-access-token '<PAT>' \
  --name "apps-cicd-demo SP creds"
```

Each target's app has its own SP — repeat once per target after its first `bundle deploy`. The CLI accepts only one credential per provider per SP, so use `update <id> gitHub` (not `create`) to rotate the PAT later.

### 6. First-time bundle init

```bash
npm ci
databricks bundle validate -t dev
databricks bundle deploy -t dev          # provisions Lakebase + creates app + sets git_repository
# Now do step 5 (configure SP creds) — needed before first apps deploy
databricks apps start db-chatbot-dev-<suffix>     # apps come up STOPPED on first creation
databricks apps deploy db-chatbot-dev-<suffix> \
  --json '{"git_source":{"branch":"main"}}'
```

The first deploy provisions a Lakebase instance — give it 5–10 minutes.

> **Why `apps start`?** A freshly-created app (right after `bundle deploy`) is in `STOPPED` compute state. `apps deploy` requires `RUNNING`, so the very first deploy needs an explicit `apps start` first. Subsequent deploys run against an already-running app and don't need it. The CI workflows include `apps start` defensively before every deploy — it's a no-op if the app is already running.

### 7. CI runner network access (workspaces with IP ACLs)

If your workspace enforces IP ACLs, the default GitHub-hosted `ubuntu-latest` runners will not be able to reach it — their egress IPs are not in the allowlist. Two paths:

- **Self-hosted runners** on a network that can reach the workspace, OR
- **Allowlist your CI runner egress IPs** at the workspace level

The workflows in this repo all use `runs-on: ubuntu-latest`. Switch to self-hosted via:

```yaml
runs-on:
  group: <your-runner-group>
  labels: <your-runner-label>
```

If the workspace doesn't enforce IP ACLs, the default runners work as-is.

## Daily workflow

| Action | What happens |
|---|---|
| Open a PR | `validate.yml` runs lint, typecheck, `bundle validate` for all three targets |
| Merge to `main` (with Conventional Commit message) | `deploy-dev.yml` deploys to dev; `release-please.yml` opens / updates a "Release vX.Y.Z" PR with bumped version + changelog |
| Merge the release PR | release-please creates the Git tag, which fires `release.yml` → deploys staging, prompts for approval, deploys prod |
| Need to roll back | Repo → Actions → "Rollback prod" → enter the previous tag (e.g. `v1.1.5`) and reason |

The running app shows the live build in the header (`v1.2.0` and the short SHA). Roll back, refresh — header updates instantly.

> **Heads up — concurrency:** `release.yml` and `rollback.yml` share a `prod-deploy` lock so the two can never deploy to prod at the same time. `release.yml` additionally serializes the whole pipeline under `release-pipeline`. Practical effect: if a release is paused on prod approval and you push a hotfix tag, the hotfix run is **queued** behind the in-flight one. To unblock, either approve the pending prod deploy or cancel the in-flight workflow run from the Actions UI.

## Release automation (optional — release-please)

If you want auto-bumped versions + auto-generated changelogs instead of typing `git tag` by hand, this repo includes a [release-please](https://github.com/googleapis/release-please-action) workflow.

**How it works:**

1. Devs use [Conventional Commit](https://www.conventionalcommits.org/) prefixes when merging to `main`:
   - `feat: add OBO scope for Genie` → minor bump (`v1.2.0` → `v1.3.0`)
   - `fix: handle empty chat history` → patch bump (`v1.2.0` → `v1.2.1`)
   - `feat!:` or `BREAKING CHANGE:` in the body → major bump (`v1.2.0` → `v2.0.0`)
   - `docs:` / `chore:` / `refactor:` → no bump (still appears in changelog)
2. release-please watches `main`. On each push it opens (or updates) a single "Release vX.Y.Z" PR with the bumped version, an auto-generated `CHANGELOG.md` entry, and the manifest update.
3. **Merging the release PR** is the human gate. Doing so creates the Git tag (`v1.2.0`), publishes a GitHub Release with the changelog, and fires `release.yml` exactly the same as a manual `git tag` would.

**Why this matters for regulated environments:**

- Every release is a reviewable PR — required-reviewers / CODEOWNERS apply normally
- Version + changelog are derived from commit history, not hand-typed (no typos, no missed entries)
- Tag creation is gated by PR merge — same change-management discipline as code changes
- Audit answer to "who decided this was v1.2.0 and why?" — the merged PR shows it
- The downstream pipeline (release.yml + rollback.yml) is unchanged

**One-time GitHub setting required:**

Settings → Actions → General → Workflow permissions → enable **"Allow GitHub Actions to create and approve pull requests"**. Without this, release-please can't open the release PR.

**Don't want it?** Delete `.github/workflows/release-please.yml`, `release-please-config.json`, and `.release-please-manifest.json`. The rest of the pipeline keeps working with manual tagging.

## Rollback strategy

There is no native one-click rollback in Databricks Apps — both rollback paths re-deploy an older Git tag through the same `apps deploy --json` mechanism. This repo implements both:

| Path | When to use | Mechanism |
|---|---|---|
| **`workflow_dispatch` re-deploy** (primary) | Any rollback, urgent or planned | `rollback.yml` runs `bundle deploy -t prod` (resource shape) + `apps deploy db-chatbot-prod --json '{"git_source":{"tag":"<old-tag>"}}'` |
| **Revert PR on `main`** (follow-up) | Trunk hygiene after a rollback | Open a "Revert <bad PR>" PR; flows through dev → staging → prod normally so `main` HEAD = what's running |

**Why `workflow_dispatch` is primary** (and not just break-glass): it's what [Databricks officially recommends](https://docs.databricks.com/aws/en/dev-tools/ci-cd/best-practices), it preserves the prod approval gate, and it's faster than waiting for a revert PR to traverse the full pipeline. The revert PR is the *trunk-hygiene step*, not the rollback itself.

**Verified rollback flow** (tested 2026-05-01 against the dev workspace — `db-chatbot-prod`):

```
2026-05-01 09:38  SUCCEEDED  tag=v0.1.0 (rollback)  resolved=834e83ec5b ← live
2026-05-01 09:35  SUCCEEDED  tag=v0.2.0             resolved=38d044e63e
2026-05-01 09:28  SUCCEEDED  tag=v0.1.0 (initial)   resolved=834e83ec5b
```

The placeholder text in the chat input is the visible diff: v0.2.0 shows "Ask anything..."; v0.1.0 shows "Ask a question...". After rollback the placeholder reverts and the deployment ledger gets a new row pointing at the old commit — same git ref as the original v0.1.0, different `deployment_id`, fresh `create_time`.

**Traceability:** With Git-backed deploy, the deployment record itself carries the Git ref. `databricks apps list-deployments` returns rows where each `git_source` looks like:

```json
{
  "tag": "v1.2.0",
  "git_repository": {"provider": "gitHub", "url": "https://github.com/<org>/<repo>"},
  "resolved_commit": "16b96f5d9ac5e738ef7caf22c4a4d29430e96cfa"
}
```

So `apps list-deployments` is a self-documenting release ledger: you can see the deployed tag/branch and the exact commit it resolved to, with no app-side workaround.

The app's UI badge reads from the **same source** — `server/src/routes/config.ts` calls `GET /api/2.0/apps/<app_name>` at runtime (cached 5 min per process) and reads `active_deployment.git_source.{tag,branch,commit,resolved_commit}`. That's why the running app's badge always reflects the actual deployed revision, and rollbacks update it on next page load. The `databricks.yml` `config.env` block (with `APP_VERSION` / `APP_GIT_REF` bundle vars) does **not** survive Git-backed deploys — the repo's `app.yaml` is the source of truth for runtime env, and our `app.yaml` doesn't declare those vars. The API-based read is the canonical path.

### Data-side rollback (Lakebase)

App rollback covers code only. A schema migration applied by the bad release is **not** undone by re-deploying old code. For destructive changes:

1. **Before the migration:** create a Lakebase branch (instant copy-on-write — see [Lakebase branching](https://www.databricks.com/blog/database-branching-postgres-git-style-workflows-databricks-lakebase))
2. **If rollback needed:** restore from the branch (single API call)
3. **If successful:** keep the branch 48–72h as a safety net, then drop

Always write **forward-compatible migrations** (add nullable column → dual-write → drop old column in a separate release) so a code rollback never requires a schema rollback.

## Manual mode (terminal) — when CI runners can't reach the workspace

For environments where GitHub Actions runners can't reach the workspace (workspace IP ACLs, air-gapped customer envs, etc.), the same flow runs from a terminal authenticated to the workspace. Use this as the canonical CLI runbook — every workflow YAML step has a 1:1 terminal equivalent.

Variables used below — adjust to your suffix names:

```bash
export DATABRICKS_CONFIG_PROFILE=<your-profile>
DEV_APP=db-chatbot-dev-<your-username-suffix>
STAGING_APP=db-chatbot-staging
PROD_APP=db-chatbot-prod
```

> **Note:** the `--var="git_sha=…"` / `--var="git_ref=…"` overrides on `bundle deploy` are vestigial under Git-backed — the repo's `app.yaml` is the source of truth for the app's runtime env, and `databricks.yml`'s `config.env` block doesn't take effect. The version badge in the running app reads `git_source` from the Apps API instead. The bundle vars still set defaults that show up if you query `databricks bundle summary`, but they don't reach the running app.

### Release v1.2.0: tag → staging → prod

```bash
git tag -a v1.2.0 -m "release notes"
git push origin v1.2.0

# Staging — bundle deploy applies resource shape, apps deploy rolls the code
databricks bundle deploy -t staging
databricks apps start "$STAGING_APP"     # no-op if already running
databricks apps deploy "$STAGING_APP" --json '{"git_source":{"tag":"v1.2.0"}}'

# Smoke test against staging URL — open the app, send a message, check the version badge

# Prod (manual approval gate = you typing this command after sign-off)
databricks bundle deploy -t prod
databricks apps start "$PROD_APP"
databricks apps deploy "$PROD_APP" --json '{"git_source":{"tag":"v1.2.0"}}'
```

### Rollback prod to v1.1.5 (the most recent good tag)

```bash
# Bundle deploy is a no-op for code-only rollback (resource shape unchanged),
# but run it for symmetry in case the resource shape from the bad tag was different
databricks bundle deploy -t prod

databricks apps start "$PROD_APP"
databricks apps deploy "$PROD_APP" --json '{"git_source":{"tag":"v1.1.5"}}'

# Confirm
databricks apps list-deployments "$PROD_APP" --output json \
  | jq '.[0:3] | .[] | {state: .status.state, tag: .git_source.tag, resolved_commit: .git_source.resolved_commit, create_time}'
```

The new deployment row will show `tag=v1.1.5` with the resolved_commit matching v1.1.5 — that's the audit answer to "what's running now."

### Dev pushes (the loop you'll iterate on most)

```bash
git push origin main           # or whatever branch you're working on
SHA=$(git rev-parse HEAD)
databricks bundle deploy -t dev --var="resource_name_suffix=dev-<suffix>"
databricks apps start "$DEV_APP"
databricks apps deploy "$DEV_APP" --json "{\"git_source\":{\"commit\":\"$SHA\"}}"
```

For dev, deploying by `commit` (not `tag`) is the natural fit — every push is a unique deployment record.

### When you have CI runners with workspace access

Skip this section. `validate.yml`, `deploy-dev.yml`, `release.yml`, and `rollback.yml` automate everything above. The terminal commands here are exactly what those workflows run, just unwrapped.

## Local development

```bash
npm ci
cp .env.example .env       # set DATABRICKS_CONFIG_PROFILE=demo
npm run dev                # client on 3000, server on 3001
```

To run against a local Lakebase mirror, see `UPSTREAM_README.md` (preserved from the upstream template) — covers `quickstart.sh`, `migrate.ts`, etc.

## Useful commands during the demo

```bash
# Release ledger — newest deployments with the Git ref each came from
databricks apps list-deployments db-chatbot-prod --output json \
  | jq '.[0:5] | .[] | {
      deployment_id,
      state: .status.state,
      tag: .git_source.tag, branch: .git_source.branch,
      resolved_commit: .git_source.resolved_commit,
      create_time, creator
    }'

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
