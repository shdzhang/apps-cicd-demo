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

- Repo → Actions → "Rollback prod" → "Run workflow"
- `ref` = `v0.1.0` (the older tag we pre-staged)
- `reason` = "demo rollback"
- Run

Walk the workflow:

- Same `bundle deploy + run` against prod
- Just with `git checkout` of the older revision
- Lakebase data is preserved — only the app code rolls back

Refresh the app — header now shows `v0.1.0` and the older SHA. Chat history is still there.

Key line: *"There's no native rollback button in Databricks. Rollback in this model = re-deploy a known-good tag through the same pipeline. Same path, same audit, same approvals — that's the feature."*

### 6. Show deployment history + audit (3 min)

Terminal:

```bash
databricks apps list-deployments db-chatbot-prod --output json | jq '.deployments[0:5] | .[] | {id, status, deployer, source_code_path}'
```

Three deployments visible: original v1.2.0, the rollback, plus whatever was there before. Each is independently accessible.

Then in a SQL editor:

```sql
SELECT event_date, user_identity.email, action_name, request_params.request_object_id
FROM system.access.audit
WHERE action_name LIKE '%AppDeployment%' OR action_name LIKE 'changeAppsAcl'
ORDER BY event_date DESC LIMIT 20
```

Point out the rollback row, the approver email if they want to chase that.

### 7. OBO recap (3 min)

Back to the `databricks.yml`. Show `user_api_scopes`. Then to `server/src/...` (briefly) to show the `X-Forwarded-Access-Token` header being read and used to construct a user-scoped client.

Key lines:
- *"Same code, two identities. SP for app-state writes, OBO for anything user-permission-sensitive."*
- *"On Day 1 you flip OBO on per-app, per-scope, per-user-consent. Defence in depth."*

Don't go deeper unless they ask — auth is its own segment.

## Common questions to expect

- **Q: Where do build artefacts live?** A: There's no build artefact for an app — `bundle deploy` uploads source to Workspace files. The "version" *is* the Git SHA the bundle was deployed from.
- **Q: Can I roll back without rebuilding?** A: Practically, just `git checkout <tag> && bundle deploy` is fast (~1 min for code-only change, no Lakebase reprovision).
- **Q: What about secrets?** A: Use Databricks Secrets, referenced by `valueFrom: secret/<scope>/<key>` in `app.yaml`. Don't put secrets in `databricks.yml` variables.
- **Q: Azure DevOps instead of GitHub Actions?** A: Same shape — `databricks` CLI runs identically. The OAuth M2M flow is identical. Service connections replace GitHub secrets.
- **Q: How do I do canary or blue/green?** A: Two apps in the bundle (`databricks_chatbot_canary` + `databricks_chatbot_main`), Front-Door / App Gateway in front splitting traffic. Native traffic-split inside Apps is on the roadmap.

## What NOT to demo (out of scope for this slot)

- Lakebase migrations / Drizzle workflow — that's a database segment, deflect to docs
- Full agent build (Mosaic AI Agent Framework code) — that's an Agent Bricks segment
- Front-End Private Link setup — covered in the networking segment

## After the demo

- Share repo URL (whatever you push it to)
- Share the engagement doc link
- Send the `pbv0/databricks-apps-dabs` reference link as the "even simpler starting point"
