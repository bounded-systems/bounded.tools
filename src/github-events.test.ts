import { describe, test, expect } from "bun:test";
import {
  adaptWorkflowRun,
  adaptPullRequest,
  type WorkflowRunPayload,
  type PullRequestPayload,
} from "./github-events";

// Each field is merged into its own default rather than replacing it, so a case
// can vary one key without restating the whole delivery.
const payload = (over: Partial<WorkflowRunPayload> = {}): WorkflowRunPayload => ({
  action: "action" in over ? over.action : "completed",
  workflow_run: {
    id: 31742116298,
    name: "standard",
    head_sha: "cba744a79a41f8416d35240c4d53898fc220f2ab",
    head_branch: "main",
    html_url: "https://github.com/bounded-systems/claude-box/actions/runs/31742116298",
    status: "completed",
    conclusion: "success",
    updated_at: "2026-08-13T20:41:26Z",
    ...over.workflow_run,
  },
  repository: {
    full_name: "bounded-systems/claude-box",
    default_branch: "main",
    ...over.repository,
  },
});

describe("adaptWorkflowRun", () => {
  test("adapts a completed default-branch run", () => {
    const r = adaptWorkflowRun(payload());
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.observation).toEqual({
      repo: "bounded-systems/claude-box",
      workflow: "standard",
      runId: 31742116298,
      conclusion: "success",
      sha: "cba744a79a41f8416d35240c4d53898fc220f2ab",
      runUrl: "https://github.com/bounded-systems/claude-box/actions/runs/31742116298",
      observedAt: "2026-08-13T20:41:26Z",
    });
  });

  // The exact class that went unnoticed for two months (claude-box#254).
  test("carries startup_failure through rather than dropping it", () => {
    const r = adaptWorkflowRun(
      payload({ workflow_run: { conclusion: "startup_failure", name: "release" } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.observation.conclusion).toBe("startup_failure");
  });

  // Recording an in-flight run would overwrite a known verdict with "no
  // verdict", so a red repo would flicker green every time someone pushed.
  test("ignores runs that have not concluded", () => {
    for (const action of ["requested", "in_progress"]) {
      const r = adaptWorkflowRun(payload({ action }));
      expect(r).toEqual({ ok: false, reason: "not-completed" });
    }
  });

  // Failing PR runs are normal; counting them would make the aggregator red
  // essentially always, which is how a monitor gets ignored.
  test("ignores runs off the default branch", () => {
    const r = adaptWorkflowRun(payload({ workflow_run: { head_branch: "claude/some-branch" } }));
    expect(r).toEqual({ ok: false, reason: "not-default-branch" });
  });

  test("follows the repo's own default branch, not a hardcoded 'main'", () => {
    const r = adaptWorkflowRun(
      payload({
        workflow_run: { head_branch: "trunk" },
        repository: { full_name: "o/r", default_branch: "trunk" },
      }),
    );
    expect(r.ok).toBe(true);
  });

  // Guessing at an undocumented terminal state is how a new failure mode gets
  // silently filed as "not red".
  test("rejects an unknown conclusion rather than guessing", () => {
    const r = adaptWorkflowRun(payload({ workflow_run: { conclusion: "exploded" } }));
    expect(r).toEqual({ ok: false, reason: "malformed" });
  });

  test("rejects deliveries missing required fields", () => {
    const cases: WorkflowRunPayload[] = [
      { action: "completed" },
      { action: "completed", workflow_run: { id: 1 }, repository: { full_name: "o/r" } },
      payload({ workflow_run: { id: undefined } }),
      payload({ workflow_run: { name: undefined } }),
      payload({ workflow_run: { html_url: undefined } }),
      payload({ workflow_run: { conclusion: null } }),
      payload({ workflow_run: { updated_at: "not a date" } }),
      payload({ repository: { full_name: undefined } }),
    ];
    for (const c of cases) {
      expect(adaptWorkflowRun(c).ok).toBe(false);
    }
  });

  test("normalises the stamp to second precision, matching the snapshot format", () => {
    const r = adaptWorkflowRun(payload({ workflow_run: { updated_at: "2026-08-13T20:41:26.512Z" } }));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.observation.observedAt).toBe("2026-08-13T20:41:26Z");
  });

  // A skip must be countable, not silent: "we ingested nothing" has to stay
  // distinguishable from "nothing was wrong".
  test("every rejection names a reason", () => {
    const reasons = [
      adaptWorkflowRun(payload({ action: "requested" })),
      adaptWorkflowRun(payload({ workflow_run: { head_branch: "x" } })),
      adaptWorkflowRun({ action: "completed" }),
    ].map((r) => (r.ok ? null : r.reason));
    expect(reasons).toEqual(["not-completed", "not-default-branch", "malformed"]);
  });
});

// ── adaptPullRequest (.github-private#719) ───────────────────────────────────

const pr = (over: Partial<PullRequestPayload> = {}): PullRequestPayload => ({
  action: "action" in over ? over.action : "opened",
  number: "number" in over ? over.number : 719,
  // `"pull_request" in over` rather than a truthiness check: a case must be
  // able to say "this delivery has NO pull_request object" by passing
  // undefined explicitly, which a `=== undefined` test would silently
  // overwrite with the default.
  pull_request: "pull_request" in over ? over.pull_request : { number: 719, draft: false },
  repository: { full_name: "bounded-systems/.github-private", ...over.repository },
});

describe("adaptPullRequest", () => {
  test("opened is a reprojection", () => {
    const r = adaptPullRequest(pr());
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.trigger).toEqual({
      repo: "bounded-systems/.github-private",
      number: 719,
      action: "opened",
    });
  });

  test("every action that changes what the feed renders", () => {
    for (const action of [
      "opened",
      "closed",
      "reopened",
      "ready_for_review",
      "converted_to_draft",
      "edited",
    ]) {
      expect(adaptPullRequest(pr({ action })).ok).toBe(true);
    }
  });

  // The load-bearing skip. A push to a PR branch is the most frequent
  // pull_request delivery in an active org and changes nothing the feed shows;
  // dispatching on it would spend a reprojection per push.
  test("synchronize is skipped — a push changes nothing the feed renders", () => {
    const r = adaptPullRequest(pr({ action: "synchronize" }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("action-not-projected");
  });

  test("other real-but-invisible actions are skipped with a reason", () => {
    for (const action of ["labeled", "unlabeled", "assigned", "review_requested"]) {
      const r = adaptPullRequest(pr({ action }));
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.reason).toBe("action-not-projected");
    }
  });

  test("a missing action is a skip, not a crash", () => {
    const r = adaptPullRequest(pr({ action: undefined }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("action-not-projected");
  });

  test("the number may arrive at the top level only", () => {
    const r = adaptPullRequest(pr({ pull_request: undefined, number: 42 }));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.trigger.number).toBe(42);
  });

  test("pull_request.number wins when both are present", () => {
    const r = adaptPullRequest(pr({ number: 1, pull_request: { number: 719 } }));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.trigger.number).toBe(719);
  });

  test("no number anywhere is malformed", () => {
    const r = adaptPullRequest(pr({ pull_request: undefined, number: undefined }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("malformed");
  });

  test("no repository is malformed", () => {
    const r = adaptPullRequest({ action: "opened", number: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("malformed");
  });
});
