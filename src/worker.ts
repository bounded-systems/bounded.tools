// bounded.tools — GitHub App receiver, as a Cloudflare Worker.
//
// Replaces the `Bun.serve` stub (src/server.ts). That stub was never deployed:
// on 2026-08-13 `GET /health` and `GET /setup` both returned the static site's
// HTML 404, not the app's plain-text `not found`, and the repo carried no
// deployment config of any kind — so the App's `hook_attributes.url` has been
// pointing at a path nothing answers. Rewriting it as a Worker therefore costs
// no migration, and buys the Durable Object the CI aggregator needs
// (.github-private#481).
//
// Deploying it is still a separate, manual step: this makes the receiver
// deployable, it does not make it deployed, and the webhook URL keeps 404ing
// until someone runs `wrangler deploy` and points a route at it.

import { CiStateDO } from "./ci-do";
import { adaptWorkflowRun, type WorkflowRunPayload } from "./github-events";
import { handleClaudeRelay } from "./claude-relay";
import { handleGithubDoor } from "./github-door";
import { listInstallationRepos } from "./reconcile";
import { decide, dispatch } from "./dispatch-events";

export { CiStateDO };

export type Env = {
  GITHUB_WEBHOOK_SECRET?: string;
  /** Named bearer leases for the read-only GitHub door (src/github-door.ts),
   *  `name:token` per line. Worker secret. Absent ⇒ the door refuses all. */
  DOOR_LEASES?: string;
  /** Broker registry app the door mints as (default bs-door-github-read). */
  DOOR_APP?: string;
  /** Named bearer leases for the Claude chat-session relay
   *  (src/claude-relay.ts), `name:token` per line. Worker secret — a separate
   *  secret from DOOR_LEASES on purpose, so each door revokes independently.
   *  The standing line; _A/_B are the deploy lane's per-session grant slots
   *  (#62), merged in the relay. All absent ⇒ the relay refuses all. */
  CLAUDE_RELAY_LEASES?: string;
  CLAUDE_RELAY_LEASES_A?: string;
  CLAUDE_RELAY_LEASES_B?: string;
  /** Manual OVERRIDE of the coverage denominator (comma-separated repos).
   *  Normally empty: the reconcile cron keeps the real list in the DO. Set it
   *  only to force a specific denominator while debugging; absent + no
   *  reconcile yet ⇒ the snapshot reports coverage as unknown. */
  CI_REPOS_KNOWN?: string;
  CI_STATE: DurableObjectNamespace;
  /** Service binding to cf-token-broker — the reconcile cron's mint path
   *  (binding.internal/apptoken/bs-door-hooks, metadata:read only) and the
   *  dispatch door's (bs-door-dispatch, contents:write on SELECTED repos). */
  BROKER: Fetcher;
  /** Broker registry entry the dispatch sender mints as. Default
   *  bs-door-dispatch. Absent from the registry ⇒ the mint 404s and the
   *  dispatch is skipped with a logged reason — the consumers' crons are the
   *  backstop, so a missing door degrades freshness rather than breaking
   *  ingestion. */
  DISPATCH_APP?: string;
};

const enc = new TextEncoder();

/** UTF-8 bytes in an explicitly ArrayBuffer-backed view.
 *
 *  `TextEncoder.encode` is typed as `ArrayBufferLike` (it may be
 *  SharedArrayBuffer-backed), which WebCrypto's `BufferSource` excludes — and
 *  this repo loads both `@types/bun` and `@cloudflare/workers-types`, so the two
 *  disagree. Copying once here keeps the cast out of the crypto call sites. */
function bytes(s: string): Uint8Array<ArrayBuffer> {
  const src = enc.encode(s);
  const out = new Uint8Array(new ArrayBuffer(src.byteLength));
  out.set(src);
  return out;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  // Backed by an explicit ArrayBuffer: WebCrypto's BufferSource excludes the
  // SharedArrayBuffer-backed view that a bare `new Uint8Array(n)` widens to.
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Verify `X-Hub-Signature-256` over the raw body.
 *
 *  Uses WebCrypto's `verify` rather than comparing digests by hand: it is
 *  constant-time by construction, so there is no hand-rolled compare to get
 *  subtly wrong, and no `nodejs_compat` flag needed. An absent secret fails
 *  CLOSED — an unconfigured receiver must reject deliveries, never accept
 *  unauthenticated ones. */
async function verifySignature(
  secret: string | undefined,
  body: string,
  header: string | null,
): Promise<boolean> {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const signature = hexToBytes(header.slice("sha256=".length));
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, bytes(body));
}

const ci = (env: Env) => env.CI_STATE.get(env.CI_STATE.idFromName("fleet"));

export default {
  // `ctx` is optional in the signature ONLY so existing callers that pass two
  // arguments keep type-checking (app-create.test.ts is one). The runtime
  // always supplies it; the fallback below awaits inline rather than assuming
  // it is there, so a two-arg caller gets correct behaviour instead of a
  // TypeError inside a webhook handler.
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") return new Response("ok");

    // The read-only GitHub door (#36) — see src/github-door.ts for the three
    // gates. Served by path, not hostname: github.bounded.tools is the naming
    // convenience, but the policy must hold on every host this Worker answers.
    if (url.pathname === "/gh" || url.pathname.startsWith("/gh/")) {
      return handleGithubDoor(request, env);
    }

    // The Claude chat-session relay (#50) — share link in, toolpath Graph out.
    // Served by path like /gh above: the policy holds on every host this
    // Worker answers.
    if (url.pathname === "/claude/sessions") {
      return handleClaudeRelay(request, env);
    }

    // The fleet CI snapshot — the sibling of the status layer's /status.json,
    // read via one owned host so a session needs one allowlist entry rather
    // than API access to 88 repos it cannot have.
    if (url.pathname === "/ci.json") {
      const known = env.CI_REPOS_KNOWN?.trim();
      const qs = known ? `?reposKnown=${encodeURIComponent(known)}` : "";
      const res = await ci(env).fetch(`https://ci/snapshot${qs}`);
      return new Response(res.body, {
        status: res.status,
        headers: {
          "content-type": "application/json",
          // Short, and consumers enforce `generated_at` regardless: a cached
          // snapshot that outlived its freshness window must read as
          // unanswered, not as healthy.
          "cache-control": "public, max-age=60",
        },
      });
    }

    // App Manifest flow, entry side (infra docs/app-surface.md). GitHub's
    // manifest flow requires a browser FORM POST (a plain link cannot carry the
    // manifest), so this page renders the form: the create-app lane passes the
    // git-declared manifest as base64url in ?m=, the human reviews it and
    // clicks the one button App creation irreducibly requires. Nothing here is
    // secret — the manifest is public config, declared in infra.
    if (url.pathname === "/app-create") {
      // ?owner= picks the creation endpoint. Defaults to "org" so every URL the
      // create-app lane has ever printed keeps working unchanged.
      //
      // This is not cosmetic. A PRIVATE App installs only on its owner, so an
      // App that must install on a personal account has to be OWNED by that
      // account — the alternative is public:true, which is unacceptable for a
      // privileged door because anyone who finds it can install it. And App
      // ownership CANNOT be changed after creation: the wrong endpoint means
      // deleting the App and starting over. Both endpoints render a page that
      // works, so the mistake is silent until someone tries to install.
      const owner = url.searchParams.get("owner") ?? "org";
      if (owner !== "org" && owner !== "user") {
        return new Response("?owner= must be 'org' or 'user'", { status: 400 });
      }
      const org = url.searchParams.get("org") ?? "bounded-systems";
      if (owner === "org" && !/^[A-Za-z0-9-]{1,39}$/.test(org)) {
        return new Response("malformed org", { status: 400 });
      }
      const action =
        owner === "user"
          ? "https://github.com/settings/apps/new"
          : `https://github.com/organizations/${org}/settings/apps/new`;
      let manifest: string;
      try {
        const b64 = (url.searchParams.get("m") ?? "").replace(/-/g, "+").replace(/_/g, "/");
        const parsed = JSON.parse(atob(b64));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("not an object");
        }
        // Strip local annotation keys. GitHub's manifest schema has a FIXED
        // field set and rejects a payload carrying fields it does not know;
        // `$comment` is the org's convention for recording why a manifest looks
        // the way it does. create-app.yml strips it upstream, so this page has
        // been safe only by virtue of its one caller sanitising first — a
        // different caller handing over a raw manifest gets a Create button
        // that silently fails. Strip here too, so the endpoint is correct on
        // its own terms rather than by luck.
        const payload = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(([k]) => !k.startsWith("$")),
        );
        manifest = JSON.stringify(payload, null, 2);
      } catch {
        return new Response("?m= must be base64url-encoded manifest JSON — generate this URL via the create-app lane", { status: 400 });
      }
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const html = `<!doctype html><meta charset="utf-8"><title>Create GitHub App — review manifest</title>
<body style="font-family:system-ui;max-width:44rem;margin:3rem auto;line-height:1.5">
<h1>Create GitHub App on ${owner === "user" ? "your user account" : esc(org)}</h1>
<p>Review the manifest (declared in <code>infra/github-admin/app-manifests/</code>), then create.
GitHub will redirect back to <code>/app-created</code> with the one-time code for the lane's
exchange phase — the private key is born machine-side; you never touch it.</p>
<form action="${esc(action)}" method="post">
<textarea name="manifest" readonly rows="18" style="width:100%;font-family:monospace">${esc(manifest)}</textarea>
<p><button type="submit" style="font-size:1.1rem;padding:.5rem 1.5rem">Create GitHub App</button></p>
</form></body>`;
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    // App Manifest flow relay (infra docs/app-surface.md). GitHub redirects the
    // browser here after the human clicks "Create GitHub App", carrying a
    // one-time code. This page RELAYS the code to the human, who pastes it into
    // the create-app lane's exchange phase — it deliberately does NOT exchange
    // the code itself: the exchange response contains the App's private key,
    // and this Worker holding PEMs (even in memory) would change the custody
    // class for nothing the lane can't do. A manifest code is a claim ticket,
    // not a key — one hour, one use, worthless once exchanged.
    if (url.pathname === "/app-created") {
      const code = url.searchParams.get("code") ?? "";
      if (!/^[A-Za-z0-9_-]{1,255}$/.test(code)) {
        return new Response("missing or malformed ?code= — this page is the App Manifest redirect target; reach it via the create-app lane, not directly", { status: 400 });
      }
      const html = `<!doctype html><meta charset="utf-8"><title>App created — relay the code</title>
<body style="font-family:system-ui;max-width:40rem;margin:3rem auto;line-height:1.5">
<h1>GitHub App created</h1>
<p>Paste this one-time code into the <strong>create-app</strong> lane's exchange phase
(<code>bounded-systems/infra</code> → Actions → <code>create-app.yml</code>, input <code>code</code>):</p>
<pre style="padding:1rem;border:1px solid #8884;user-select:all">${code}</pre>
<p>It expires in one hour and dies on first use. The lane exchanges it, validates the
App, and writes the private key straight into the broker's Worker Secrets — no human
ever holds the PEM.</p></body>`;
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/setup") {
      const installationId = url.searchParams.get("installation_id");
      const action = url.searchParams.get("setup_action");
      console.log(`[setup] installation_id=${installationId} action=${action}`);
      return new Response(
        `bounded.tools: received install ${installationId} (${action}). Setup TODO.`,
      );
    }

    if (url.pathname === "/api/github/webhooks" && request.method === "POST") {
      const body = await request.text();
      if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get("x-hub-signature-256")))) {
        return new Response("invalid signature", { status: 401 });
      }

      const event = request.headers.get("x-github-event");
      const payload = JSON.parse(body) as WorkflowRunPayload & { installation?: { id?: number } };

      if (event === "workflow_run") {
        const result = adaptWorkflowRun(payload);
        if (!result.ok) {
          // Logged, not silent: "ingested nothing" and "nothing was wrong" must
          // stay distinguishable.
          console.log(`[workflow_run] skipped reason=${result.reason}`);
          return new Response("ok");
        }
        await ci(env).fetch("https://ci/observe", {
          method: "POST",
          body: JSON.stringify(result.observation),
        });
        console.log(
          `[workflow_run] ${result.observation.repo} ${result.observation.workflow} -> ${result.observation.conclusion}`,
        );
        return new Response("ok");
      }

      // ── The dispatch sender (.github-private#779) ──────────────────────
      //
      // The projections declare `repository_dispatch` receivers and had never
      // received one, because no sender was ever built — so they ran on cron
      // alone, and an hourly cron on GitHub Actions is not a delivery
      // guarantee (36 of ~106 slots over 106 hours; the one DAILY lane in the
      // same repo took ~98%). The board read 6h46m stale on 2026-08-29 (#801)
      // and a session cannot read it any other way (#431).
      //
      // ALWAYS 200, WHATEVER HAPPENS BELOW. GitHub disables a webhook whose
      // deliveries keep failing, so throwing here to report a dispatch problem
      // would cost the events that still work — including `workflow_run`,
      // which is this Worker's original job. Failures are logged and the
      // consumers' crons remain the backstop.
      const decision = decide(event, payload.action);
      if (!decision.ok) {
        // Logged with the reason, never silent. An absent sender stayed
        // invisible for weeks precisely because nothing said the path was
        // cold; a sender that drops deliveries quietly would be the same
        // defect wearing a fix.
        console.log(`[webhook] event=${event} action=${payload.action ?? ""} skip=${decision.reason}`);
        return new Response("ok");
      }

      const work = (async () => {
        const app = env.DISPATCH_APP ?? "bs-door-dispatch";
        const mint = await env.BROKER.fetch(`https://binding.internal/apptoken/${app}`, { method: "POST" });
        if (!mint.ok) {
          // 403 here is the broker's own scope guard (infra#529) refusing a
          // privileged door whose installation has been widened past the repos
          // it is registered for. That is a correct refusal, not a transport
          // fault, and it names itself in the broker's logs — so say which
          // status came back rather than collapsing to "mint failed".
          console.error(`[dispatch] broker mint ${app} failed: ${mint.status}`);
          return;
        }
        const { token } = (await mint.json()) as { token?: string };
        if (!token) {
          console.error(`[dispatch] broker returned no token for ${app}`);
          return;
        }
        // Per target, not all-or-nothing: one repo refusing must not cost the
        // other its wake-up. Both are needed — waking only the private lane
        // leaves the PUBLIC feed stale, which is where the wrong number was
        // actually read.
        const outcomes = await Promise.all(decision.targets.map((t) => dispatch(t, token)));
        for (const o of outcomes) {
          const line = `${o.target.repo} <- ${o.target.eventType} (${o.status})`;
          if (o.ok) console.log(`[dispatch] ${line}`);
          else console.error(`[dispatch] FAILED ${line}`);
        }
      })().catch((e) => {
        console.error(`[dispatch] failed: ${e instanceof Error ? e.message : e}`);
      });
      if (ctx?.waitUntil) ctx.waitUntil(work);
      else await work;

      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },

  // The reconcile cron (.github-private#481 increment 4): refresh the coverage
  // denominator from the App's live installation list. Failure of any step
  // leaves the stored list UNTOUCHED — a stale-but-real denominator beats a
  // partial or empty one, and the DO refuses empty writes independently.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const mint = await env.BROKER.fetch("https://binding.internal/apptoken/bs-door-hooks", {
          method: "POST",
        });
        if (!mint.ok) {
          console.error(`[reconcile] broker mint failed: ${mint.status}`);
          return;
        }
        const { token } = (await mint.json()) as { token?: string };
        if (!token) {
          console.error("[reconcile] broker returned no token");
          return;
        }
        const repos = await listInstallationRepos(token);
        const res = await ci(env).fetch("https://ci/reposKnown", {
          method: "POST",
          body: JSON.stringify({ repos }),
        });
        const body = await res.json();
        console.log(`[reconcile] repos=${repos.length} stored=${JSON.stringify(body)}`);
      })().catch((e) => {
        // Caught and logged rather than thrown: a reconcile failure must show
        // up in logs and as a stale denominator, never as a crashed cron that
        // Cloudflare silently retries into the same wall.
        console.error(`[reconcile] failed: ${e instanceof Error ? e.message : e}`);
      }),
    );
  },
};
