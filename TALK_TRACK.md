# Talk track — CI/CD demo segment (≈25 min)

Internal-only. Sequence and what to say at each step. The 90-min agenda from the engagement doc puts this between minute 50 and 75.

## Set-up before the call

- [ ] Workspace logged in via `databricks auth login --profile demo`
- [ ] Three service principals created and named (`apps-cicd-dev/staging/prod`); OAuth secrets generated and stored in GitHub repo secrets
- [ ] First `bundle deploy -t dev` already done so the Lakebase instance is warm (cold provision is 5–10 min — don't do it live)
- [ ] An older tag (`v0.1.0`) already deployed to prod, so we have something to roll back from
- [ ] Two browser tabs open: the GitHub Actions page and the deployed app URL
- [ ] Terminal pre-loaded with `databricks apps list-deployments db-chatbot-prod`
- [ ] App header version badge visible — confirm the SHA matches the current prod tag

## Flow

### 1. Walk the `databricks.yml` (3 min)

Pull up the file. Highlight:

- One file describes everything — app, Lakebase instance, serving endpoint binding, permissions, OBO scopes, env vars
- `targets:` shows dev / staging / prod — same shape, different suffix
- `user_api_scopes:` is what enables OBO. Each scope is the *minimum permission grant needed for the user’s token to be useful downstream*.
- `git_sha` and `git_ref` are bundle variables — the CI overrides them with `--var=` so the running app advertises what build is live

Key line to deliver: *"There's nothing here that says 'CI/CD'. The bundle is just configuration. Whatever runs `databricks bundle deploy` IS the CI/CD."*

### 2. Open a PR — show validate (3 min)

Open an existing PR (or branch + push live). Click into Actions. Walk through:

- `build-and-test` job: `npm ci`, `npm run lint`, build, unit tests
- `bundle-validate` job: `databricks bundle validate -t dev/staging/prod` — schema check against three targets, no deploy
- This is where shift-left lives. Bad YAML, missing variables, mistyped scopes — all caught before merge.

### 3. Merge to main — show dev deploy (3 min)

Merge the PR. Switch to Actions → `Deploy to Dev`. While it runs:

- `bundle deploy -t dev` — uploads source, applies terraform-managed resources (app, Lakebase, permissions, scopes)
- `bundle run` — creates a new App **deployment**; that's the unit Databricks tracks
- Each `bundle run` produces a `deployment_id` you can list with `apps list-deployments`

Refresh the app — version badge in header should now be the new SHA.

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

- `git checkout v0.1.0`, then `bundle deploy + bundle run` against prod
- The deployment_id in `apps list-deployments` is a server-generated 32-char hex string — opaque, not human-readable. The traceable identity is the **Git tag + the `git_sha` env var the app exposes in its header**. Pair them with the audit log (`service_name = 'apps'`, `action_name = 'deployApp'` — verified live; rename-defensive wording in the README) if you need to map a deployment_id back to a tag.
- Lakebase data is preserved — only the app code rolls back

Refresh the app — header now shows `v0.1.0` and the older SHA. Chat history is still there.

Key line: *"There's no native rollback button in Databricks. Rollback in this model = re-deploy a known-good tag through the same pipeline. Same path, same audit, same approvals — that's the feature."*

**Then add the data-side beat (the bit DBAs care about):** *"Code rollback is the easy half. The hard half is data — once a migration runs, redeploying old app code does NOT undo it. The pattern is: take a Lakebase branch right before any risky migration. Lakebase branching is copy-on-write, so the snapshot is instant regardless of DB size. If the migration is bad, you restore from the branch with a single API call. Keep the branch 48–72h, then drop it. That's the regulated-environment story end to end — code via Git tag, data via Lakebase branch."*

**Trunk hygiene follow-up (mention briefly):** *"Once prod is back on `v0.1.0`, `main` still points at the bad commit. Open a revert PR on `main` and let it flow through dev → staging → prod normally. Now `main` HEAD = what's running. Standard trunk-based hygiene — but it's a follow-up, not the rollback itself."*

### 6. Show deployment history + audit (3 min)

Terminal:

```bash
databricks apps list-deployments db-chatbot-prod --output json \
  | jq '.[0:5] | .[] | {deployment_id, status, creator, create_time, source_code_path}'
```

Three deployments visible — IDs are server-generated 32-char hex strings (opaque). Map them back to releases via `create_time` + the audit log + the `git_sha` the running app exposes in its header.

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
- **Q: Can I roll back without rebuilding?** A: Yes — that's exactly what the rollback workflow does, with the prod approval gate and audit trail attached. The underlying mechanic is `git checkout <tag> && bundle deploy + bundle run` (~1 min for code-only change, no Lakebase reprovision); going through the workflow keeps the gate and trail intact.
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
