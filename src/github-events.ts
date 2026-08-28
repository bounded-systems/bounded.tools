// github-events — pure adapter from a GitHub `workflow_run` webhook to a
// CI observation (.github-private#481).
//
// Kept separate from the Worker so the interesting decisions — which deliveries
// count, which are ignored, and *why* — are testable without a runtime, a
// signature, or a network. The Worker's job is transport; this file's job is
// judgement.
//
// Every rejection returns a REASON rather than a bare null. A CI monitor that
// silently drops deliveries is indistinguishable from one watching a healthy
// fleet, which is the failure this whole project exists to stop; a countable
// reason is what makes "we ingested nothing" visibly different from "nothing
// was wrong".

import type { Conclusion, Observation } from "./ci-state";

/** The subset of a `workflow_run` delivery this adapter reads. Deliberately
 *  narrow — anything not named here cannot influence the outcome. */
export type WorkflowRunPayload = {
  action?: string;
  workflow_run?: {
    id?: number;
    name?: string;
    head_sha?: string;
    head_branch?: string;
    html_url?: string;
    status?: string;
    conclusion?: string | null;
    updated_at?: string;
  };
  repository?: {
    full_name?: string;
    default_branch?: string;
  };
};

export type AdaptResult =
  | { ok: true; observation: Observation }
  | { ok: false; reason: AdaptSkipReason };

export type AdaptSkipReason =
  | "not-completed" // action !== "completed": the run has not concluded yet
  | "not-default-branch" // a PR/feature-branch run; fleet health is default-branch health
  | "malformed"; // required fields absent — a delivery we cannot trust

const CONCLUSIONS: ReadonlySet<string> = new Set([
  "success",
  "failure",
  "startup_failure",
  "timed_out",
  "cancelled",
  "skipped",
  "neutral",
  "action_required",
  "stale",
]);

/** Second-precision RFC 3339, matching the snapshot stamp. GitHub sends
 *  `updated_at` in exactly this shape already, but a delivery is external input
 *  and normalising here keeps the one format rule in one place. */
function normaliseStamp(raw: string): string | null {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/** Adapt one delivery.
 *
 *  Two filters carry real weight:
 *
 *  - **`action === "completed"`.** `requested`/`in_progress` deliveries carry a
 *    null conclusion; recording them would overwrite a known verdict with "no
 *    verdict" every time a run starts, so a red repo would flicker green the
 *    moment someone pushed.
 *
 *  - **default branch only.** Fleet health is the state of `main`. A failing PR
 *    run is normal and expected — counting it would make the aggregator red
 *    essentially always, which is the fastest way to get a monitor ignored. */
export function adaptWorkflowRun(payload: WorkflowRunPayload): AdaptResult {
  if (payload.action !== "completed") return { ok: false, reason: "not-completed" };

  const run = payload.workflow_run;
  const repo = payload.repository;
  const fullName = repo?.full_name;
  const defaultBranch = repo?.default_branch;

  if (!run || !fullName || !defaultBranch) return { ok: false, reason: "malformed" };
  if (run.head_branch !== defaultBranch) return { ok: false, reason: "not-default-branch" };

  const { id, name, head_sha, html_url, conclusion, updated_at } = run;
  if (
    typeof id !== "number" ||
    !name ||
    !head_sha ||
    !html_url ||
    !updated_at ||
    typeof conclusion !== "string" ||
    !CONCLUSIONS.has(conclusion)
  ) {
    // An unknown conclusion string lands here on purpose. Guessing at a value
    // GitHub has not documented is how a new terminal state would get silently
    // filed as "not red".
    return { ok: false, reason: "malformed" };
  }

  const observedAt = normaliseStamp(updated_at);
  if (!observedAt) return { ok: false, reason: "malformed" };

  return {
    ok: true,
    observation: {
      repo: fullName,
      workflow: name,
      runId: id,
      conclusion: conclusion as Conclusion,
      sha: head_sha,
      runUrl: html_url,
      observedAt,
    },
  };
}

// ── pull_request -> PR-projection reprojection (.github-private#719) ─────────
//
// The PR feed at prs.bounded.tools is an hourly cron snapshot, and the cron is
// not reliable: measured 2026-08-28, its lane had fired zero scheduled runs
// since creation, and the sibling board lane's "hourly" starts show gaps of two
// to ten hours. .github-private#719 added a `repository_dispatch` trigger of
// type `pr-activity` so something can say when reality changed. This adapter
// decides which deliveries are worth saying it for.

/** The subset of a `pull_request` delivery this adapter reads. */
export type PullRequestPayload = {
  action?: string;
  number?: number;
  pull_request?: { number?: number; draft?: boolean };
  repository?: { full_name?: string };
};

export type PrAdaptResult =
  | { ok: true; trigger: { repo: string; number: number; action: string } }
  | { ok: false; reason: PrAdaptSkipReason };

export type PrAdaptSkipReason =
  | "action-not-projected" // real event, but nothing the feed renders changed
  | "malformed"; // required fields absent - a delivery we cannot trust

/** The actions that change what the PR feed RENDERS.
 *
 *  The feed lists open PRs with their repo, number, title and draft state, so
 *  the set is derived from that projection rather than from what feels
 *  important: open-ness (`opened`/`closed`/`reopened`), draft state
 *  (`ready_for_review`/`converted_to_draft`), and title (`edited`).
 *
 *  `synchronize` is deliberately ABSENT and is the one worth naming: a push to
 *  a PR branch is the single most frequent pull_request delivery in an active
 *  org, and it changes nothing the feed shows. Including it would spend a
 *  reprojection per push - the "noise machine nobody reads" shape the org's
 *  dependabot template warns about, transposed onto CI minutes. Same for
 *  `labeled`, `assigned` and `review_requested`: real events, invisible here. */
const REPROJECTING_ACTIONS: ReadonlySet<string> = new Set([
  "opened",
  "closed",
  "reopened",
  "ready_for_review",
  "converted_to_draft",
  "edited",
]);

/** Adapt one `pull_request` delivery into a decision to reproject.
 *
 *  Returns a REASON on skip for the same purpose the workflow_run adapter does:
 *  a receiver that silently drops deliveries is indistinguishable from one
 *  watching a quiet org, and "we dispatched nothing" must stay visibly
 *  different from "nothing happened". */
export function adaptPullRequest(payload: PullRequestPayload): PrAdaptResult {
  const action = payload.action;
  if (!action || !REPROJECTING_ACTIONS.has(action)) {
    return { ok: false, reason: "action-not-projected" };
  }

  const repo = payload.repository?.full_name;
  // GitHub sends the number at the top level AND inside pull_request; either is
  // authoritative, and a delivery carrying neither is not one to act on.
  const number = payload.pull_request?.number ?? payload.number;

  if (!repo || typeof number !== "number") return { ok: false, reason: "malformed" };

  return { ok: true, trigger: { repo, number, action } };
}
