# bounded.tools

The GitHub App receiver + setup endpoint for **prx** — backs the org-owned
GitHub App [`bounded-systems-prx`](https://github.com/organizations/bounded-systems/settings/apps/bounded-systems-prx)
(installation `138039680`). Lives in its own repo by design; prx owns the
[app definition](https://github.com/bounded-systems/prx/blob/main/docs/github-app.md)
(`.github/prx-app.manifest.json`), this repo owns the runtime.

> **Status: NOT DEPLOYED.** Measured 2026-08-13: `GET /health` and `GET /setup`
> both return the static site's HTML 404, and the repo carried no deployment
> config of any kind — so the App's `hook_attributes.url`
> (`https://bounded.tools/api/github/webhooks`) has been pointing at a path
> nothing answers, and no delivery has ever been handled. Check the App's
> recent deliveries before assuming any event-driven behaviour has run.
>
> The code below is a **Cloudflare Worker** and is deployable
> (`wrangler deploy`), but deploying it and pointing a route at
> `bounded.tools/api/*` is a manual step nobody has taken yet.

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

Not wired yet (tracked in `.github-private#481`): the reconcile poll that
catches repos which emit no events, and two blocking App-settings changes —
`workflow_run` in `default_events` and `actions: read` in `default_permissions`.
Without the first, the receiver never sees the `startup_failure` class that let
claude-box#254 sit dead for two months.

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
