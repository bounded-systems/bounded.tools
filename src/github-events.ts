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
