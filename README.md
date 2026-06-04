# bounded.tools

The GitHub App receiver + setup endpoint for **prx** — backs the org-owned
GitHub App [`bounded-systems-prx`](https://github.com/organizations/bounded-systems/settings/apps/bounded-systems-prx)
(installation `138039680`). Lives in its own repo by design; prx owns the
[app definition](https://github.com/bounded-systems/prx/blob/main/docs/github-app.md)
(`.github/prx-app.manifest.json`), this repo owns the runtime.

> **Status: stub.** Verifies webhook signatures and logs events; `/setup`
> captures the installation id. Mapping events → prx actor verbs (and the
> future `webhook → local prx` forward) is **prx-0qr**; the Projects v2 sync is
> **prx-h1e**.

## Endpoints

| Route | Purpose |
|---|---|
| `POST /api/github/webhooks` | GitHub event receiver — verifies `X-Hub-Signature-256`, dispatches |
| `GET /setup` | Post-install redirect target — captures `installation_id` / `setup_action` |
| `GET /health` | Liveness |

## Run

```sh
cp .env.example .env   # fill in the secrets (never commit them)
bun run dev
```

## Config (env)

- `GITHUB_APP_ID` — the App ID of `bounded-systems-prx`
- `GITHUB_WEBHOOK_SECRET` — verifies inbound deliveries
- `GITHUB_PRIVATE_KEY_PATH` — the App private key (`.pem`); JWT → installation token
- `PORT` — default 8787

Secrets live in sops/agenix/env, never the repo (mirrors prx's keymaker
deployment-master pattern).

## Next (tracked in prx)

- **prx-0qr** — map events to prx actor verbs (intake / triage / forge / publisher); `webhook → local` dev forward.
- **prx-h1e** — sync a GitHub Projects v2 board from beads (the `/setup` flow picks the board).
- **prx-dqf** — keeper's own GitHub SSH signing key (keymaker ed25519 → Verified commits).
