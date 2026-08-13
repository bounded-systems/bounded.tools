// Property tests for the reducer's ONE load-bearing algebraic claim
// (.github-private#481): the fold over observations is order-insensitive.
//
// Webhook delivery is unordered and the reconcile poll replays history; the
// design's answer is "newest-runId-wins makes that safe". These properties are
// that answer, stated as executable universals over the SHIPPED TypeScript —
// the middle rung of the proofs repo's ladder (types → property tests → model
// checking → theorem proving). The Lean/TLA+ twin in bounded-systems/proofs
// proves the same claims over a model of this reducer; this file is the half
// that cannot drift from the code, because it runs the code.
//
// A reordering bug here would not crash. It would serve a stale success over a
// live failure — wrong green, silently — which is the exact failure class the
// aggregator exists to eliminate. That is what buys these tests their place in
// the lane.

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { applyAll, emptyState, toSnapshot, type Observation } from "./ci-state";

const NOW = new Date("2026-08-13T21:00:00Z");

// A small universe on purpose: few repos/workflows and a narrow runId range
// force key collisions and runId ties, which is where an ordering bug would
// live. A wide random space would almost never generate the interesting cases.
const arbObservation: fc.Arbitrary<Observation> = fc.record({
  repo: fc.constantFrom("o/a", "o/b", "o/c"),
  workflow: fc.constantFrom("standard", "release"),
  runId: fc.integer({ min: 1, max: 20 }),
  conclusion: fc.constantFrom(
    "success",
    "failure",
    "startup_failure",
    "cancelled",
    null,
  ) as fc.Arbitrary<Observation["conclusion"]>,
  sha: fc.string({ unit: fc.constantFrom(..."0123456789abcdef"), minLength: 7, maxLength: 7 }),
  runUrl: fc.constant("https://example.invalid/run"),
  observedAt: fc.constant("2026-08-13T20:00:00Z"),
});

/** The confluence hypothesis, made explicit: within one (repo, workflow),
 *  a runId names ONE observation. GitHub guarantees this (run ids are unique);
 *  the reducer's first-wins tie-break relies on it, and the Lean twin carries
 *  it as a named hypothesis rather than silently assuming it. The generator
 *  enforces it the same way: for colliding (key, runId) pairs, keep the first,
 *  matching how a re-delivery carries the same payload. */
const arbObservationSet: fc.Arbitrary<Observation[]> = fc
  .array(arbObservation, { maxLength: 30 })
  .map((observations) => {
    const seen = new Map<string, Observation>();
    for (const o of observations) {
      const id = `${o.repo}::${o.workflow}::${o.runId}`;
      if (!seen.has(id)) seen.set(id, o);
    }
    return [...seen.values()];
  });

/** Compare through the snapshot, the object's public face. `generated_at` is
 *  pinned by NOW so only fold-derived fields can differ. */
const snapshotOf = (observations: readonly Observation[]) =>
  toSnapshot(applyAll(emptyState(), observations), { now: NOW });

describe("reducer algebra (the Lean twin's theorems, run against the real code)", () => {
  test("confluence: any permutation of the same observations folds to the same state", () => {
    fc.assert(
      fc.property(
        arbObservationSet.chain((set) =>
          fc.tuple(fc.constant(set), fc.shuffledSubarray(set, { minLength: set.length })),
        ),
        ([set, shuffled]) => {
          expect(snapshotOf(shuffled)).toEqual(snapshotOf(set));
        },
      ),
    );
  });

  test("idempotence: replaying any prefix (reconcile poll over webhook history) changes nothing", () => {
    fc.assert(
      fc.property(
        arbObservationSet.chain((set) =>
          fc.tuple(fc.constant(set), fc.shuffledSubarray(set)),
        ),
        ([set, replay]) => {
          expect(snapshotOf([...set, ...replay])).toEqual(snapshotOf(set));
        },
      ),
    );
  });

  test("split-brain convergence: webhook stream and poll stream fold to the same state either way round", () => {
    // The deployment reality: some observations arrive as webhooks, some via
    // the reconcile poll, with overlap. Whichever source lands first, the
    // state must converge.
    fc.assert(
      fc.property(
        arbObservationSet.chain((set) =>
          fc.tuple(
            fc.constant(set),
            fc.shuffledSubarray(set), // the webhook subset
            fc.shuffledSubarray(set), // the poll subset, overlapping freely
          ),
        ),
        ([set, webhooks, poll]) => {
          const union = new Set([...webhooks, ...poll]);
          fc.pre(union.size === set.length); // only compare when together they cover the set
          expect(snapshotOf([...webhooks, ...poll])).toEqual(snapshotOf([...poll, ...webhooks]));
          expect(snapshotOf([...webhooks, ...poll])).toEqual(snapshotOf(set));
        },
      ),
    );
  });

  test("monotone runIds: the surviving entry per key is the max concluded runId", () => {
    fc.assert(
      fc.property(arbObservationSet, (set) => {
        const state = applyAll(emptyState(), set);
        for (const [key, entry] of Object.entries(state.entries)) {
          const rivals = set.filter(
            (o) => `${o.repo}::${o.workflow}` === key && o.conclusion !== null,
          );
          expect(entry.runId).toBe(Math.max(...rivals.map((o) => o.runId)));
        }
      }),
    );
  });
});
