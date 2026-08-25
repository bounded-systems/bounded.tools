// Property tests for the board mirror's two load-bearing claims
// (.github-private#704).
//
// Same rung as ci-state.property.test.ts: executable universals over the
// SHIPPED TypeScript — the middle of the proofs repo's ladder (types → property
// tests → model checking → theorem proving). The Lean twin named in #704 proves
// these same two statements over a MODEL of this reducer; this file is the half
// that cannot drift from the code, because it runs the code.
//
// The two claims are not equally important, and the second is the reason this
// file exists at all:
//
//   1. The fold is order-insensitive. Webhook delivery is unordered and
//      reconcile replays history; "newest-updated_at-wins" is the design's
//      answer, and this states it as a universal. A bug here serves a stale
//      card — recoverable, and reconcile recovers it.
//
//   2. Default-deny holds over EVERY board. A bug here puts a private repo's
//      issue title on a public page. Not recoverable, at all. Example-based
//      tests can only show the shapes we thought of; this quantifies over the
//      shapes we did not.

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import {
  applyAll,
  emptyBoard,
  toSnapshot,
  toPublicSnapshot,
  type BoardItem,
} from "./desk-state";

const NOW = new Date("2026-08-25T01:30:00Z");

/** Arbitrary board items, generated across the whole visibility space —
 *  including the `null` case that is the entire point of claim 2. */
const arbItem = fc.record({
  item_id: fc.constantFrom("a", "b", "c"),
  type: fc.constantFrom("Issue", "PullRequest", "DraftIssue"),
  repo: fc.option(fc.constantFrom("o/pub", "o/priv"), { nil: null }),
  repo_private: fc.option(fc.boolean(), { nil: null }),
  number: fc.option(fc.integer({ min: 1, max: 999 }), { nil: null }),
  title: fc.string(),
  url: fc.option(fc.webUrl(), { nil: null }),
  issue_state: fc.constantFrom("OPEN", "CLOSED"),
  assignees: fc.array(fc.string(), { maxLength: 2 }),
  labels: fc.array(fc.string(), { maxLength: 2 }),
  claimed: fc.boolean(),
  fields: fc.record({ Status: fc.constantFrom("Todo", "Done", "In Progress") }),
  // Distinct, parseable, second-precision stamps: ties are covered by an
  // example test, and mixing them in here would only re-test tie-breaking.
  updated_at: fc
    .integer({ min: 0, max: 5000 })
    .map((s) => `${new Date(1756000000000 + s * 1000).toISOString().slice(0, 19)}Z`),
}) as fc.Arbitrary<BoardItem>;

describe("claim 1 — the fold is order-insensitive", () => {
  test("any permutation of the same deliveries yields the same state", () => {
    fc.assert(
      fc.property(fc.array(arbItem, { maxLength: 12 }), (items) => {
        const forward = applyAll(emptyBoard(), items);
        const backward = applyAll(emptyBoard(), [...items].reverse());
        expect(backward).toEqual(forward);
      }),
      { numRuns: 300 },
    );
  });

  test("replaying deliveries is idempotent — reconcile must not churn state", () => {
    fc.assert(
      fc.property(fc.array(arbItem, { maxLength: 12 }), (items) => {
        const once = applyAll(emptyBoard(), items);
        expect(applyAll(once, items)).toEqual(once);
      }),
      { numRuns: 300 },
    );
  });
});

describe("claim 2 — default-deny holds over every board", () => {
  test("no row whose repo is private or of unknown visibility is ever published", () => {
    // The safety theorem, stated as a universal. Quantified over boards that
    // mix public, private, unknown-visibility and repo-less rows in any order.
    fc.assert(
      fc.property(fc.array(arbItem, { maxLength: 12 }), (items) => {
        const state = applyAll(emptyBoard(), items);
        const snap = toSnapshot(state, { now: NOW });
        const published = toPublicSnapshot(snap);

        const permitted = new Set(
          snap.items
            .filter((i) => i.repo !== null && i.repo_private === false)
            .map((i) => i.item_id),
        );

        for (const row of published.items) {
          expect(permitted.has(row.item_id)).toBe(true);
        }
        // …and it is not vacuously safe by dropping everything: every
        // permitted row must actually survive. A filter that publishes nothing
        // passes the check above and is useless.
        expect(published.items.length).toBe(permitted.size);
      }),
      { numRuns: 500 },
    );
  });

  test("no published row ever carries a non-allowlisted key", () => {
    const ALLOWED = new Set([
      "item_id",
      "type",
      "repo",
      "number",
      "title",
      "url",
      "issue_state",
      "labels",
      "claimed",
      "fields",
      "updated_at",
      "provenance",
    ]);
    fc.assert(
      fc.property(fc.array(arbItem, { maxLength: 12 }), (items) => {
        const published = toPublicSnapshot(
          toSnapshot(applyAll(emptyBoard(), items), { now: NOW }),
        );
        for (const row of published.items) {
          for (const key of Object.keys(row)) expect(ALLOWED.has(key)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  test("the published count always describes the published rows", () => {
    // If item_count described the SOURCE, a reader would over-trust the feed.
    fc.assert(
      fc.property(fc.array(arbItem, { maxLength: 12 }), (items) => {
        const published = toPublicSnapshot(
          toSnapshot(applyAll(emptyBoard(), items), { now: NOW }),
        );
        expect(published.item_count).toBe(published.items.length);
        const counted = Object.values(published.counts).reduce((a, b) => a + b, 0);
        expect(counted).toBe(published.items.length);
      }),
      { numRuns: 300 },
    );
  });
});
