// Gates for the keeper-approval route, pinned in ORDER.
//
// The order is the property. This route can wake a lane that holds a
// write-scoped credential, so "we authenticated it" is worth nothing if a
// decision was reached first. Same shape as github-door.test.ts.

import { expect, test } from "bun:test";
import {
  ALLOWED_REQUEST_TYPES,
  ALLOWED_WORKFLOWS,
  decideKeeperDispatch,
  TIMESTAMP_WINDOW_S,
  verifyNotice,
} from "./keeper-approval";

const SECRET = "s3cret";
const NOW = 1_756_000_000_000;
const TS = String(Math.floor(NOW / 1000));

const NOTICE = {
  v: "bounded.approval-notice.v1",
  ceremonyId: "cer-abcdefgh",
  requestType: "bounded.harness-request.v1",
  request: {
    v: "bounded.harness-request.v1",
    repo: ".github-private",
    workflow: "front-desk-reroll.yml",
    run_id: "1",
    head_sha: "a".repeat(40),
    repos: "lone",
    branch: "claude/adopt-pr-claim",
    auto: "false",
  },
};

async function sign(secret: string, ts: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${body}`));
  return `sha256=${Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ── verify ───────────────────────────────────────────────────────────────────

test("an absent secret is 503, never a pass", async () => {
  const body = JSON.stringify(NOTICE);
  const r = await verifyNotice(undefined, body, TS, await sign(SECRET, TS, body), NOW);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.status).toBe(503);
});

test("503 and 401 are distinct — 'the receiver is unconfigured' never reads as 'your signature is wrong'", async () => {
  const body = JSON.stringify(NOTICE);
  const unconfigured = await verifyNotice(undefined, body, TS, "sha256=00", NOW);
  const wrong = await verifyNotice(SECRET, body, TS, "sha256=" + "0".repeat(64), NOW);
  expect(unconfigured.ok).toBe(false);
  expect(wrong.ok).toBe(false);
  if (!unconfigured.ok && !wrong.ok) expect(unconfigured.status).not.toBe(wrong.status);
});

test("a good signature verifies", async () => {
  const body = JSON.stringify(NOTICE);
  expect((await verifyNotice(SECRET, body, TS, await sign(SECRET, TS, body), NOW)).ok).toBe(true);
});

test("a body edited after signing fails", async () => {
  const body = JSON.stringify(NOTICE);
  const sig = await sign(SECRET, TS, body);
  const tampered = JSON.stringify({ ...NOTICE, request: { ...NOTICE.request, repos: "" } });
  expect((await verifyNotice(SECRET, tampered, TS, sig, NOW)).ok).toBe(false);
});

test("a captured notice cannot be RE-STAMPED — the timestamp is inside the signed string", async () => {
  const body = JSON.stringify(NOTICE);
  const sig = await sign(SECRET, TS, body);
  const fresher = String(Number(TS) + 60);
  // Same body, same signature, a newer timestamp that is inside the window:
  // this is exactly the replay the window alone would admit.
  const r = await verifyNotice(SECRET, body, fresher, sig, NOW + 60_000);
  expect(r.ok).toBe(false);
});

test("a stale timestamp is refused even with a valid signature", async () => {
  const stale = String(Math.floor(NOW / 1000) - TIMESTAMP_WINDOW_S - 1);
  const body = JSON.stringify(NOTICE);
  const r = await verifyNotice(SECRET, body, stale, await sign(SECRET, stale, body), NOW);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toMatch(/window/);
});

test("a future timestamp is refused too — the window is two-sided", async () => {
  const future = String(Math.floor(NOW / 1000) + TIMESTAMP_WINDOW_S + 1);
  const body = JSON.stringify(NOTICE);
  const r = await verifyNotice(SECRET, body, future, await sign(SECRET, future, body), NOW);
  expect(r.ok).toBe(false);
});

test("a malformed signature or timestamp is refused without throwing", async () => {
  const body = JSON.stringify(NOTICE);
  for (const [ts, sig] of [[TS, "nothex"], [TS, "sha256=xyz"], [TS, "sha256=abc"], ["", "sha256=00"], ["notanum", "sha256=00"]] as const) {
    const r = await verifyNotice(SECRET, body, ts, sig, NOW);
    expect(r.ok).toBe(false);
  }
});

// ── decide ───────────────────────────────────────────────────────────────────

test("a verified, allowlisted notice yields a per-lane event type", () => {
  const d = decideKeeperDispatch(NOTICE);
  expect(d.ok).toBe(true);
  if (d.ok) {
    expect(d.eventType).toBe("keeper-approval-front-desk-reroll");
    expect(d.repo).toBe(".github-private");
  }
});

test("a repo outside the allowlist is 403 — a notice CHOOSES FROM the list, never EXTENDS it", () => {
  const d = decideKeeperDispatch({ ...NOTICE, request: { ...NOTICE.request, repo: "some-other-repo" } });
  expect(d.ok).toBe(false);
  if (!d.ok) expect(d.status).toBe(403);
});

test("a workflow outside the allowlist is 403 even in an allowed repo", () => {
  const d = decideKeeperDispatch({ ...NOTICE, request: { ...NOTICE.request, workflow: "deploy.yml" } });
  expect(d.ok).toBe(false);
  if (!d.ok) expect(d.status).toBe(403);
});

test("a well-formed workflow name is not enough — membership is checked too", () => {
  // The regex alone would admit this; only the allowlist refuses it.
  const d = decideKeeperDispatch({ ...NOTICE, request: { ...NOTICE.request, workflow: "totally-fine.yml" } });
  expect(d.ok).toBe(false);
});

test("path traversal in the workflow name is refused", () => {
  for (const w of ["../../evil.yml", "a/b.yml", "evil.yml\n", ".github/workflows/x.yml"]) {
    expect(decideKeeperDispatch({ ...NOTICE, request: { ...NOTICE.request, workflow: w } }).ok).toBe(false);
  }
});

test("an un-dispatchable request type is 403", () => {
  const d = decideKeeperDispatch({ ...NOTICE, requestType: "bounded.deploy-request.v1" });
  expect(d.ok).toBe(false);
  if (!d.ok) expect(d.status).toBe(403);
});

test("a malformed ceremonyId is 400 — it becomes a replay key, so it must be well-formed", () => {
  for (const c of ["", "short", "has spaces", "x".repeat(65), 42, null, undefined]) {
    const d = decideKeeperDispatch({ ...NOTICE, ceremonyId: c as never });
    expect(d.ok).toBe(false);
  }
});

test("a missing request object is 400, not a crash", () => {
  expect(decideKeeperDispatch({ ceremonyId: "cer-abcdefgh", requestType: ALLOWED_REQUEST_TYPES[0] }).ok).toBe(false);
  expect(decideKeeperDispatch({}).ok).toBe(false);
});

test("every allowlisted workflow maps to a distinct event type", () => {
  // Per-lane event types are the reason one approval wakes one lane. A
  // collision would silently wake the wrong one.
  const seen = new Set<string>();
  for (const [repo, workflows] of Object.entries(ALLOWED_WORKFLOWS)) {
    for (const workflow of Object.keys(workflows)) {
      const d = decideKeeperDispatch({ ...NOTICE, request: { ...NOTICE.request, repo, workflow } });
      expect(d.ok).toBe(true);
      if (d.ok) {
        expect(seen.has(d.eventType)).toBe(false);
        seen.add(d.eventType);
      }
    }
  }
  expect(seen.size).toBe(Object.values(ALLOWED_WORKFLOWS).flatMap((w) => Object.keys(w)).length);
});
