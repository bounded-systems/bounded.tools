# bounded.tools

The GitHub App receiver + setup endpoint for **prx** — backs the org-owned
GitHub App [`bounded-systems-prx`](https://github.com/organizations/bounded-systems/settings/apps/bounded-systems-prx)
(installation `138039680`). Lives in its own repo by design; prx owns the
[app definition](https://github.com/bounded-systems/prx/blob/main/docs/github-app.md)
(`.github/prx-app.manifest.json`), this repo owns the runtime.

> **Status: DEPLOYED, not yet ingesting.** First light 2026-08-15 (run
> 31889379320): `GET https://hooks.bounded.tools/health` returns `ok` and
> `/ci.json` serves a valid snapshot. The receiver still **rejects every
> delivery** (fails closed, by design) until a deploy runs with
> `sync_webhook_secret=true` — which generates the secret as an OIDC artifact,
> writes the Worker half under its minted token, and PATCHes the App's hook
> config (secret + URL re-aim to `https://hooks.bounded.tools/api/github/webhooks`)
> through the broker's `/apphook/bounded-tools` tier. Until then the App's
> `hook_attributes.url` still points at the apex path the static site 404s.
>
> The Worker deploys via `deploy.yml` (OIDC → cf-token-broker mint,
> human-approved) to its custom domain **`hooks.bounded.tools`** — the sibling
> precedent of `boot.`/`status.`; apex zone routes would need a zone permission
> beyond what the mint carries (first-time custom-domain attach already needed
> the broker's zone-scoped `domains` read family, infra#311).

Previously a `Bun.serve` process (`src/server.ts`). Rewritten as a Worker for
the fleet CI aggregator (`.github-private#481`), which needs a Durable Object
for serialized state; since nothing was deployed, that cost no migration.

## Endpoints

| Route | Purpose |
|---|---|
| `POST /api/github/webhooks` | GitHub event receiver — verifies `X-Hub-Signature-256`, ingests `workflow_run` |
| `GET /ci.json` | Fleet CI snapshot — see below |
| `GET /setup` | Post-install redirect target — captures `installation_id` / `setup_action` |
| `GET /health` | Liveness |

## `/ci.json` — the fleet CI snapshot

Answers "which repos are red?", which no session can answer for itself: the
GitHub API 403s for any repo not attached to the session (84 of 88 org repos,
measured), while the App is installed org-wide. The sibling of the status
layer's `/status.json`, so a session allowlists **one owned host**.

Consumers **must** enforce two fields, for the reason
`docs/handoffs/service-status-layer.md` gives — a reachable-but-stuck snapshot
serving cheerful green is worse than none, because a parseable snapshot
suppresses the checks that would have disagreed:

- **`generated_at`** — RFC 3339 UTC, second precision (jq's `fromdateiso8601`
  rejects fractional seconds). Older than ~10 minutes is *unanswered*, not
  healthy.
- **`coverage_complete`** — false when coverage is partial **or unknown**. A
  snapshot with this false has not seen the fleet and must not render as
  "all green"; `unobserved` names the repos it has never heard from.

The coverage denominator comes from the **reconcile cron** (hourly): a
broker-minted installation token over the service-binding plane
(`binding.internal/apptoken/bs-door-hooks`, `metadata: read` only) lists the
App's installed repos into the DO. An empty list is refused at the DO — a
failed reconcile shows up as a stale denominator, never as "coverage complete
over nothing". `CI_REPOS_KNOWN` remains as a manual override for debugging.
The App's `workflow_run` + `actions: read` settings are declared in its
manifest (infra `github-admin/app-manifests/bs-door-hooks.json`) from birth.

Still not wired (tracked in `.github-private#481`): push-on-transition, and
using `actions: read` to backfill each repo's latest default-branch run so a
repo that emits no events still gets a truthful red/green rather than only
appearing in `unobserved`.

## Run

```sh
bun install
bun run dev            # wrangler dev
bun test               # pure modules (ci-state, github-events)
bun run typecheck
bun run check:worker   # wrangler deploy --dry-run — the only check the Worker builds
```

## Config

Worker vars live in `wrangler.jsonc`; secrets are set with `wrangler secret put`
and never committed.

- `GITHUB_WEBHOOK_SECRET` *(secret)* — verifies inbound deliveries. **Absent ⇒
  every delivery is rejected**; the receiver fails closed rather than accepting
  unauthenticated events. **Nobody holds this value**: the deploy lane
  (`deploy.yml`) generates it per run and writes both halves — the Worker
  Secret under its broker-minted token, and the App's hook config through the
  broker's `/apphook/bounded-tools` tier. Rotation is a re-run of the lane.
- `CI_REPOS_KNOWN` *(var)* — comma-separated repos the App is installed on, the
  denominator for snapshot coverage. Leave empty rather than guessing: empty
  reports coverage as *unknown*, which is honest; a wrong list claims
  completeness it does not have.

## Next (tracked in prx)

- **prx-0qr** — map events to prx actor verbs (intake / triage / forge / publisher); `webhook → local` dev forward.
- **prx-h1e** — sync a GitHub Projects v2 board from beads (the `/setup` flow picks the board).
- **prx-dqf** — keeper's own GitHub SSH signing key (keymaker ed25519 → Verified commits).
