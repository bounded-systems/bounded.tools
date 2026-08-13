// Tests for the CI aggregator's pure core (.github-private#481).
//
// These pin the ways a CI monitor lies, not just the happy path — every case
// below is one that would let a broken fleet render as a healthy one.

import { describe, test, expect } from "bun:test";
import {
  applyAll,
  applyObservation,
  emptyState,
  isStale,
  snapshotAgeSeconds,
  stampRfc3339,
  toSnapshot,
  STALE_AFTER_SECONDS,
  type Observation,
} from "./ci-state";

const NOW = new Date("2026-08-13T21:00:00.000Z");

const obs = (over: Partial<Observation> = {}): Observation => ({
  repo: "bounded-systems/claude-box",
  workflow: "standard",
  runId: 100,
  conclusion: "success",
  sha: "cba744a7",
  runUrl: "https://github.com/bounded-systems/claude-box/actions/runs/100",
  observedAt: "2026-08-13T20:41:26Z",
  ...over,
});

describe("applyObservation", () => {
  test("records a concluded run", () => {
    const s = applyObservation(emptyState(), obs());
    expect(Object.keys(s.entries)).toEqual(["bounded-systems/claude-box::standard"]);
  });

  test("keeps one entry per (repo, workflow), newest run winning", () => {
    const s = applyAll(emptyState(), [
      obs({ runId: 100, conclusion: "failure" }),
      obs({ runId: 101, conclusion: "success" }),
    ]);
    expect(Object.keys(s.entries)).toHaveLength(1);
    expect(s.entries["bounded-systems/claude-box::standard"]!.conclusion).toBe("success");
  });

  // Webhook delivery is unordered and the reconcile poll replays history, so
  // this is the normal case, not an exotic one.
  test("an out-of-order OLD run cannot overwrite a newer one", () => {
    const s = applyAll(emptyState(), [
      obs({ runId: 101, conclusion: "failure" }),
      obs({ runId: 100, conclusion: "success" }), // arrives late, is older
    ]);
    expect(s.entries["bounded-systems/claude-box::standard"]!.conclusion).toBe("failure");
  });

  test("a re-delivered identical run is a no-op", () => {
    const first = applyObservation(emptyState(), obs({ runId: 100 }));
    const again = applyObservation(first, obs({ runId: 100 }));
    expect(again.entries).toEqual(first.entries);
  });

  // An in-flight run must not erase the last known verdict.
  test("an unconcluded run is ignored, leaving the previous verdict standing", () => {
    const s = applyAll(emptyState(), [
      obs({ runId: 100, conclusion: "failure" }),
      obs({ runId: 101, conclusion: null }),
    ]);
    expect(s.entries["bounded-systems/claude-box::standard"]!.conclusion).toBe("failure");
  });

  test("workflows in the same repo are tracked separately", () => {
    const s = applyAll(emptyState(), [
      obs({ workflow: "standard", conclusion: "success" }),
      obs({ workflow: "release", conclusion: "startup_failure" }),
    ]);
    expect(Object.keys(s.entries)).toHaveLength(2);
  });
});

describe("red classification", () => {
  // The claude-box#254 case: ~95 consecutive startup_failures over two months.
  // The run never schedules a job, so anything reading job results misses it.
  test("startup_failure is red", () => {
    const snap = toSnapshot(
      applyObservation(emptyState(), obs({ workflow: "release", conclusion: "startup_failure" })),
      { now: NOW },
    );
    expect(snap.red).toHaveLength(1);
    expect(snap.red[0]!.conclusion).toBe("startup_failure");
  });

  test("failure and timed_out are red", () => {
    const snap = toSnapshot(
      applyAll(emptyState(), [
        obs({ workflow: "a", conclusion: "failure" }),
        obs({ workflow: "b", conclusion: "timed_out" }),
      ]),
      { now: NOW },
    );
    expect(snap.red).toHaveLength(2);
  });

  // Crying wolf on deliberate outcomes is how a monitor gets muted.
  test("cancelled and skipped are not red", () => {
    const snap = toSnapshot(
      applyAll(emptyState(), [
        obs({ workflow: "a", conclusion: "cancelled" }),
        obs({ workflow: "b", conclusion: "skipped" }),
      ]),
      { now: NOW },
    );
    expect(snap.red).toEqual([]);
  });

  test("red entries are sorted by repo then workflow (stable output)", () => {
    const snap = toSnapshot(
      applyAll(emptyState(), [
        obs({ repo: "o/z", workflow: "b", conclusion: "failure" }),
        obs({ repo: "o/a", workflow: "b", conclusion: "failure" }),
        obs({ repo: "o/z", workflow: "a", conclusion: "failure" }),
      ]),
      { now: NOW },
    );
    expect(snap.red.map((r) => `${r.repo}/${r.workflow}`)).toEqual(["o/a/b", "o/z/a", "o/z/b"]);
  });
});

describe("coverage — a partial sweep must not read as a fleet-wide one", () => {
  // The failure that produced #481: a sweep covering 4 of 88 repos reported
  // "3 red" and that was heard as the state of the fleet.
  test("a repo never observed is named, not counted as green", () => {
    const snap = toSnapshot(applyObservation(emptyState(), obs({ repo: "o/seen" })), {
      now: NOW,
      reposKnown: ["o/seen", "o/quiet", "o/also-quiet"],
    });
    expect(snap.repos_known).toBe(3);
    expect(snap.repos_observed).toBe(1);
    expect(snap.unobserved).toEqual(["o/also-quiet", "o/quiet"]);
    expect(snap.coverage_complete).toBe(false);
  });

  test("coverage_complete only when every known repo was observed", () => {
    const snap = toSnapshot(
      applyAll(emptyState(), [obs({ repo: "o/a" }), obs({ repo: "o/b" })]),
      { now: NOW, reposKnown: ["o/a", "o/b"] },
    );
    expect(snap.coverage_complete).toBe(true);
    expect(snap.unobserved).toEqual([]);
  });

  // Unknown coverage is not complete coverage.
  test("a missing installation list reports coverage unknown, never complete", () => {
    const snap = toSnapshot(applyObservation(emptyState(), obs()), { now: NOW });
    expect(snap.repos_known).toBeNull();
    expect(snap.coverage_complete).toBe(false);
  });

  // An aggregator that has heard from nothing is the most dangerous state:
  // zero red is literally true and completely misleading.
  test("an empty state reports zero red AND zero coverage", () => {
    const snap = toSnapshot(emptyState(), { now: NOW, reposKnown: ["o/a", "o/b"] });
    expect(snap.red).toEqual([]);
    expect(snap.repos_observed).toBe(0);
    expect(snap.coverage_complete).toBe(false);
    expect(snap.unobserved).toEqual(["o/a", "o/b"]);
  });
});

describe("freshness", () => {
  // jq's fromdateiso8601 rejects fractional seconds. Emitting toISOString()
  // directly would make every snapshot we ever served parse as unanswered.
  test("generated_at is second-precision RFC 3339 UTC, never milliseconds", () => {
    const stamp = stampRfc3339(new Date("2026-08-13T21:00:00.123Z"));
    expect(stamp).toBe("2026-08-13T21:00:00Z");
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("snapshot carries that stamp", () => {
    const snap = toSnapshot(emptyState(), { now: new Date("2026-08-13T21:00:00.999Z") });
    expect(snap.generated_at).toBe("2026-08-13T21:00:00Z");
  });

  test("age is computed from the stamp", () => {
    const snap = toSnapshot(emptyState(), { now: NOW });
    expect(snapshotAgeSeconds(snap, new Date("2026-08-13T21:05:00Z"))).toBe(300);
  });

  test("fresh snapshot is not stale", () => {
    const snap = toSnapshot(emptyState(), { now: NOW });
    expect(isStale(snap, new Date(NOW.getTime() + (STALE_AFTER_SECONDS - 1) * 1000))).toBe(false);
  });

  // A stuck aggregator serving a cheerful green is worse than no aggregator,
  // because a parseable snapshot suppresses the checks that would disagree.
  test("a snapshot past the threshold is stale", () => {
    const snap = toSnapshot(emptyState(), { now: NOW });
    expect(isStale(snap, new Date(NOW.getTime() + (STALE_AFTER_SECONDS + 1) * 1000))).toBe(true);
  });

  test("missing or unparseable stamps are stale, never fresh", () => {
    expect(isStale({}, NOW)).toBe(true);
    expect(isStale({ generated_at: "not a date" }, NOW)).toBe(true);
    expect(snapshotAgeSeconds({ generated_at: "not a date" }, NOW)).toBeNull();
  });
});
