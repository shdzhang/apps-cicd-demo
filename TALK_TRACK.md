# Talk track — CI/CD demo segment (≈25 min) — Git-backed variant

Internal-only. Sequence and what to say at each step. The 90-min agenda from the engagement doc puts this between minute 50 and 75.

This branch demos the **Git-backed app deploy flow** that went GA on 2026-04-21. Compared with `main` (workspace-file upload), this is the version Databricks now recommends — Git is the source of truth, every deployment record carries the deployed commit natively, and there's a workspace-level admin policy ("Only allow app deployments from Git") that maps cleanly onto regulatory change-management requirements.

## Set-up before the call

- [ ] Workspace logged in via `databricks auth login --profile demo`
- [ ] Three service principals (`apps-cicd-dev/staging/prod`) created; OAuth secrets in GitHub repo Environments
- [ ] **App SP Git credentials configured** — for each target's app SP, attach a fine-grained GitHub PAT (Contents:Read on the repo) via `databricks git-credentials create gitHub --principal-id <app_sp_id> ...`. Without this the platform can't clone the repo at deploy time.
- [ ] First `bundle deploy -t dev` already done so the Lakebase instance is warm (cold provision is 5–10 min — don't do it live)
- [ ] An older tag (`v0.1.0`) already deployed to prod, so we have something to roll back from
- [ ] Two browser tabs open: the GitHub Actions page and the deployed app URL
- [ ] Terminal pre-loaded with the `apps list-deployments` jq incantation from the README — the one that surfaces `git_source.tag/branch` + `resolved_commit`
- [ ] App header version badge visible — confirm it matches the current prod tag

## Flow

### 1. Walk the `databricks.yml` (3 min)

Pull up the file. Highlight:

- One file describes everything — app, Lakebase instance, serving endpoint binding, permissions, OBO scopes
- `targets:` shows dev / staging / prod — same shape, different suffix
- `user_api_scopes:` is what enables OBO. Each scope is the *minimum permission grant needed for the user's token to be useful downstream*.
- `git_repository` + `git_source` — the platform pulls source directly from this Git repo at the ref specified. No workspace-file upload of source code.

Key line to deliver: *"There's nothing here that says 'CI/CD'. The bundle is just configuration — including the Git repo it points at. Whatever runs `databricks bundle deploy` to apply this config + `databricks apps deploy` to roll a Git ref IS the CI/CD."*

If they ask about the admin enforcement: *"There's a workspace-level setting — Settings → Development → Apps → 'Only allow app deployments from Git' — that turns this on for every app in the workspace. For a regulated environment, that's the policy enforcement: every prod deploy is a reviewable Git ref."*

### 2. Open a PR — show validate (3 min)

Open an existing PR (or branch + push live). Click into Actions. Walk through:

- `build-and-test` job: `npm ci`, `npm run lint`, build, unit tests
- `bundle-validate` job: `databricks bundle validate -t dev/staging/prod` — schema check against three targets, no deploy
- This is where shift-left lives. Bad YAML, missing variables, mistyped scopes — all caught before merge.

### 3. Merge to main — show dev deploy (3 min)

Merge the PR. Switch to Actions → `Deploy to Dev`. While it runs:

- `bundle deploy -t dev` — applies terraform-managed resources (app config, Lakebase, permissions, scopes, `git_repository` association). No source upload — the app's `source_code_path` field is gone, replaced by `git_source`.
- `apps deploy <app> --json '{"git_source":{"commit":"<sha>"}}'` — the platform clones the repo (via the SP's Git credential) at that exact commit and rolls out a deployment.

Refresh the app — the version badge in the header updates to the new tag (e.g. `v1.2.0`). The badge reads from the Apps API at runtime (`active_deployment.git_source` — see `server/src/routes/config.ts`), so it always reflects what's actually deployed without us injecting env vars from CI. Open the deployment list in the terminal: `git_source.resolved_commit` shows the same commit on the deployment record itself.

### 4. Cut a release — staging then prod (5 min)

```bash
git tag -a v1.2.0 -m "demo release"
git push origin v1.2.0
```

Switch to Actions → `Release (staging → prod)`. Two stages:

- `deploy-staging` runs to completion
- `deploy-prod` is **paused** waiting for approval (this is the GitHub Environment we configured)

Approve in the UI. Watch prod deploy.

Key line: *"This is the gate. In a regulated bank you have one or more named approvers per environment. They can require ticket numbers, change-window confirmation, whatever — that's pure GitHub config, no Databricks involvement."*

### 5. The rollback (5 min)

This is the moment they're most curious about. Be deliberate.

**Frame it first:** there is no native one-click rollback in Databricks Apps today (confirmed by Apps engineering — not on the roadmap). Databricks officially recommends what we're about to demo: a `workflow_dispatch` that re-deploys a previous Git tag through the same pipeline. This is the *primary* rollback mechanism, not a break-glass exception.

- Repo → Actions → "Rollback prod" → "Run workflow"
- `ref` = `v0.1.0` (the older tag we pre-staged)
- `reason` = "demo rollback"
- Run

Walk the workflow:

- `apps deploy db-chatbot-prod --json '{"git_source":{"tag":"v0.1.0"}}'` — that's it. No `git checkout`, no source upload. The platform clones the tag directly via the SP's Git credential. `bundle deploy` only re-asserts the resource shape (which is unchanged for a code rollback).
- The new deployment record carries `git_source.tag = "v0.1.0"` and `resolved_commit` for that tag. `apps list-deployments` reads as a clean ledger — `tag/branch/commit` + `resolved_commit` are right there per row, no audit-log workaround needed.
- Lakebase data is preserved — only the app code rolls back.

Refresh the app — header badge now reads `v0.1.0` and the placeholder reverts to "Ask a question..." (the visible diff between v0.1.0 and the rolled-back tag). Chat history is still there. The badge updates because the API-based read picks up the new active deployment on next refresh.

Key line: *"There's no native rollback button in Databricks. Rollback in this model = re-deploy a known-good tag through the same pipeline. Same path, same audit, same approvals — that's the feature."*

**Then add the data-side beat (the bit DBAs care about):** *"Code rollback is the easy half. The hard half is data — once a migration runs, redeploying old app code does NOT undo it. The pattern is: take a Lakebase branch right before any risky migration. Lakebase branching is copy-on-write, so the snapshot is instant regardless of DB size. If the migration is bad, you restore from the branch with a single API call. Keep the branch 48–72h, then drop it. That's the regulated-environment story end to end — code via Git tag, data via Lakebase branch."*

**Trunk hygiene follow-up (mention briefly):** *"Once prod is back on `v0.1.0`, `main` still points at the bad commit. Open a revert PR on `main` and let it flow through dev → staging → prod normally. Now `main` HEAD = what's running. Standard trunk-based hygiene — but it's a follow-up, not the rollback itself."*

### 6. Show deployment history + audit (3 min)

Terminal:

```bash
databricks apps list-deployments db-chatbot-prod --output json \
  | jq '.[0:5] | .[] | {
      deployment_id,
      state: .status.state,
      tag: .git_source.tag, branch: .git_source.branch,
      resolved_commit: .git_source.resolved_commit,
      create_time, creator
    }'
```

Three deployments visible. Each row shows the deployed `tag/branch` + `resolved_commit`. Self-documenting release ledger — that's the feature Git-backed unlocks.

Then in a SQL editor:

```sql
SELECT event_time, user_identity.email, action_name, request_params
FROM system.access.audit
WHERE service_name = 'apps'
ORDER BY event_time DESC LIMIT 20
```

Point out the deploy/rollback rows and the approver/deployer emails.

### 7. OBO recap (3 min)

Back to the `databricks.yml`. Show `user_api_scopes`. Then to `server/src/...` (briefly) to show the `X-Forwarded-Access-Token` header being read and used to construct a user-scoped client.

Key lines:
- *"Same code, two identities. SP for app-state writes, OBO for anything user-permission-sensitive."*
- *"On Day 1 you flip OBO on per-app, per-scope, per-user-consent. Defence in depth."*

Don't go deeper unless they ask — auth is its own segment.

## Common questions to expect

- **Q: Where do build artefacts live?** A: There's no build artefact for an app — `bundle deploy` uploads source to Workspace files. The "version" *is* the Git SHA the bundle was deployed from.
- **Q: Can I roll back without rebuilding?** A: Yes — that's exactly what the rollback workflow does, with the prod approval gate and audit trail attached. The underlying mechanic is one CLI call: `databricks apps deploy <app> --json '{"git_source":{"tag":"<old-tag>"}}'`. The platform clones that tag directly. ~1 min for code-only change, no Lakebase reprovision. Going through the workflow keeps the gate and trail intact.
- **Q: What about secrets?** A: Use Databricks Secrets, referenced by `valueFrom: secret/<scope>/<key>` in `app.yaml`. Don't put secrets in `databricks.yml` variables.
- **Q: Azure DevOps instead of GitHub Actions?** A: Same shape — `databricks` CLI runs identically. The OAuth M2M flow is identical. Service connections replace GitHub secrets.
- **Q: How do I do canary or blue/green?** A: Two apps in the bundle (`databricks_chatbot_canary` + `databricks_chatbot_main`), Front-Door / App Gateway in front splitting traffic. Native traffic-split inside Apps is on the roadmap.
- **Q: A release is paused on prod approval and I need to push a hotfix tag — what happens?** A: The hotfix workflow run is *queued* behind the in-flight release (workflow-level `release-pipeline` concurrency lock). To unblock: either approve the in-flight prod deploy and let the hotfix release behind it, or cancel the in-flight workflow run from the Actions UI. Same lock prevents two simultaneous tag pushes from racing each other through staging.

## What NOT to demo (out of scope for this slot)

- Lakebase migrations / Drizzle workflow — that's a database segment, deflect to docs
- Full agent build (Mosaic AI Agent Framework code) — that's an Agent Bricks segment
- Front-End Private Link setup — covered in the networking segment

## After the demo

- Share repo URL (whatever you push it to)
- Share the engagement doc link
- Send the `pbv0/databricks-apps-dabs` reference link as the "even simpler starting point"
