import { describe, test, expect } from "bun:test";
import { adaptWorkflowRun, type WorkflowRunPayload } from "./github-events";

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
