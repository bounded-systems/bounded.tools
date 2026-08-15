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

export { CiStateDO };

export type Env = {
  GITHUB_WEBHOOK_SECRET?: string;
  /** Comma-separated repos the App is installed on, for snapshot coverage.
   *  Absent ⇒ the snapshot reports coverage as unknown rather than guessing. */
  CI_REPOS_KNOWN?: string;
  CI_STATE: DurableObjectNamespace;
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") return new Response("ok");

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
      const org = url.searchParams.get("org") ?? "bounded-systems";
      if (!/^[A-Za-z0-9-]{1,39}$/.test(org)) return new Response("malformed org", { status: 400 });
      let manifest: string;
      try {
        const b64 = (url.searchParams.get("m") ?? "").replace(/-/g, "+").replace(/_/g, "/");
        manifest = JSON.stringify(JSON.parse(atob(b64)), null, 2);
      } catch {
        return new Response("?m= must be base64url-encoded manifest JSON — generate this URL via the create-app lane", { status: 400 });
      }
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const html = `<!doctype html><meta charset="utf-8"><title>Create GitHub App — review manifest</title>
<body style="font-family:system-ui;max-width:44rem;margin:3rem auto;line-height:1.5">
<h1>Create GitHub App on ${esc(org)}</h1>
<p>Review the manifest (declared in <code>infra/github-admin/app-manifests/</code>), then create.
GitHub will redirect back to <code>/app-created</code> with the one-time code for the lane's
exchange phase — the private key is born machine-side; you never touch it.</p>
<form action="https://github.com/organizations/${esc(org)}/settings/apps/new" method="post">
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

      console.log(`[webhook] event=${event} action=${payload.action ?? ""}`);
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },
};
