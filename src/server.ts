// bounded.tools — GitHub App receiver + setup endpoint for prx
// (bounded-systems-prx). STUB: verifies webhook signatures and logs events;
// /setup captures the installation id. Event → prx actor dispatch is prx-0qr.

import { createHmac, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8787);
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";

/** Verify a GitHub `X-Hub-Signature-256` over the raw body (constant-time). */
function verifySignature(body: string, signature: string | null): boolean {
  if (!WEBHOOK_SECRET || !signature) return false;
  const expected =
    "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") return new Response("ok");

    // Post-install redirect target (Setup URL).
    if (url.pathname === "/setup") {
      const installationId = url.searchParams.get("installation_id");
      const action = url.searchParams.get("setup_action");
      console.log(`[setup] installation_id=${installationId} action=${action}`);
      // TODO(prx-0qr): persist installation_id → org; finish onboarding
      // (prx-h1e: let the operator pick a Project to sync).
      return new Response(
        `bounded.tools: received install ${installationId} (${action}). Setup TODO.`,
      );
    }

    // GitHub event receiver.
    if (url.pathname === "/api/github/webhooks" && req.method === "POST") {
      const body = await req.text();
      if (!verifySignature(body, req.headers.get("x-hub-signature-256"))) {
        return new Response("invalid signature", { status: 401 });
      }
      const event = req.headers.get("x-github-event");
      const payload = JSON.parse(body) as {
        action?: string;
        installation?: { id?: number };
      };
      console.log(
        `[webhook] event=${event} action=${payload.action ?? ""} installation=${payload.installation?.id ?? ""}`,
      );
      // TODO(prx-0qr): map (event, action) → prx actor verb
      // (issues→intake/triage, pull_request/check_suite→forge/publisher);
      // future: forward to a local prx (webhook→local).
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`bounded.tools stub listening on :${server.port}`);
