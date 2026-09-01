/**
 * The keeper says a Face ID landed; decide whether to wake a lane.
 *
 * WHY THIS ROUTE EXISTS (`.github-private`#847). Every ceremony-gated lane used
 * to hold a GitHub Actions runner open while a human decided — measured at
 * 15m 18s of runner for zero work on one lapsed run. The keeper now posts an
 * approval notice instead, and this decides what to do with it.
 *
 * WHY IT IS PURE. Everything here is a decision over bytes: no fetch, no env
 * beyond a secret string, no clock it does not receive. The route in worker.ts
 * does the I/O. That split is what lets the gate ORDER be pinned by tests —
 * which is the property that matters, because "we authenticated it" is worth
 * nothing if a mint happened first. `github-door.test.ts` pins its gates this
 * way and those are the best tests in this repo.
 *
 * THE TRUST BOUNDARY, STATED ONCE. This route can wake a lane that holds a
 * write-scoped credential. An unauthenticated route here hands anyone that
 * capability. So every gate below is fail-closed, and the allowlist is the
 * reason a keeper compromise still cannot aim the dispatch App at a repo the
 * Worker was not already willing to wake:
 *
 *     A signed notice may CHOOSE FROM the allowlist. It can never EXTEND it.
 *
 * That is the same invariant `dispatch-events.ts` already holds ("a caller
 * cannot name any of them"), kept intact rather than loosened for a new caller.
 */

import type { DispatchType } from "./dispatch-events";

/** Notices older or newer than this are refused. Covers clock skew, not latency. */
export const TIMESTAMP_WINDOW_S = 300;

/** Request types this route will act on. Hardcoded; a notice cannot add one. */
export const ALLOWED_REQUEST_TYPES = Object.freeze(["bounded.harness-request.v1"]);

/**
 * Which (repo, workflow) pairs may be woken. Hardcoded per repo, not per notice.
 *
 * `.github-private` only: `bs-door-dispatch`'s installation on `.github` is not
 * established, so `site-deploy.yml` stays out until it is. Adding a repo here is
 * a deliberate edit with an installation check behind it, which is the point.
 */
export const ALLOWED_WORKFLOWS: Readonly<Record<string, Readonly<Record<string, DispatchType>>>> = Object.freeze({
  ".github-private": Object.freeze({
    "front-desk-reroll.yml": "keeper-approval-front-desk-reroll",
    "adopt-claude-harness.yml": "keeper-approval-adopt-claude-harness",
    "merge-claude-harness.yml": "keeper-approval-merge-claude-harness",
    "reroll-claude-harness.yml": "keeper-approval-reroll-claude-harness",
    "org-baseline.yml": "keeper-approval-org-baseline",
    "org-sync.yml": "keeper-approval-org-sync",
  }),
});

const WORKFLOW_RE = /^[A-Za-z0-9._-]+\.ya?ml$/;

export type Notice = {
  v?: unknown;
  ceremonyId?: unknown;
  requestType?: unknown;
  request?: { repo?: unknown; workflow?: unknown; [k: string]: unknown };
  [k: string]: unknown;
};

export type Decision =
  | { ok: true; repo: string; workflow: string; ceremonyId: string; eventType: DispatchType }
  | { ok: false; status: 400 | 403; reason: string };

/**
 * Constant-time HMAC verify over `${timestamp}.${body}`.
 *
 * The timestamp is part of the SIGNED STRING, not merely a header beside it —
 * so a captured notice cannot be replayed with a fresh timestamp to slide
 * through the window above. An absent secret returns false here and the route
 * turns that into a 503; it must never be read as "no signature required".
 */
export async function verifyNotice(
  secret: string | undefined,
  rawBody: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  nowMs: number,
): Promise<{ ok: true } | { ok: false; status: 401 | 503; reason: string }> {
  if (!secret) return { ok: false, status: 503, reason: "notify secret not configured" };
  if (!timestampHeader || !/^\d{1,15}$/.test(timestampHeader)) {
    return { ok: false, status: 401, reason: "missing or malformed timestamp" };
  }
  const skew = Math.abs(Math.floor(nowMs / 1000) - Number(timestampHeader));
  if (skew > TIMESTAMP_WINDOW_S) return { ok: false, status: 401, reason: "timestamp outside window" };
  if (!signatureHeader?.startsWith("sha256=")) {
    return { ok: false, status: 401, reason: "missing signature" };
  }
  const hex = signatureHeader.slice("sha256=".length);
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return { ok: false, status: 401, reason: "malformed signature" };
  }
  const sig = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < sig.length; i++) sig[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const good = await crypto.subtle.verify("HMAC", key, sig, enc.encode(`${timestampHeader}.${rawBody}`));
  return good ? { ok: true } : { ok: false, status: 401, reason: "signature mismatch" };
}

/**
 * Decide from an ALREADY-VERIFIED notice. Every value is checked against a
 * hardcoded set; nothing here is taken on the notice's word.
 */
export function decideKeeperDispatch(notice: Notice): Decision {
  const { ceremonyId, requestType, request } = notice;
  if (typeof ceremonyId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(ceremonyId)) {
    return { ok: false, status: 400, reason: "missing or malformed ceremonyId" };
  }
  if (typeof requestType !== "string" || !ALLOWED_REQUEST_TYPES.includes(requestType)) {
    return { ok: false, status: 403, reason: `request type not dispatchable: ${String(requestType)}` };
  }
  const repo = request?.repo;
  const workflow = request?.workflow;
  if (typeof repo !== "string" || typeof workflow !== "string") {
    return { ok: false, status: 400, reason: "request is missing repo or workflow" };
  }
  const allowed = ALLOWED_WORKFLOWS[repo];
  if (!allowed) return { ok: false, status: 403, reason: `repo not dispatchable: ${repo}` };
  // Shape AND membership. The regex alone would admit any well-formed name.
  if (!WORKFLOW_RE.test(workflow)) {
    return { ok: false, status: 403, reason: `workflow not dispatchable: ${repo}/${workflow}` };
  }
  // LOOKED UP, never derived. Deriving the event type by string surgery would
  // produce a `string`, and the whole point of DispatchType being a closed
  // union is that a caller cannot name an event type. This map is the only
  // place a new lane's wake-up can be added, and TypeScript checks each value
  // against the union.
  const eventType = Object.prototype.hasOwnProperty.call(allowed, workflow) ? allowed[workflow] : undefined;
  if (!eventType) {
    return { ok: false, status: 403, reason: `workflow not dispatchable: ${repo}/${workflow}` };
  }
  return { ok: true, repo, workflow, ceremonyId, eventType };
}
