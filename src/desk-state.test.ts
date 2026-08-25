// Tests for the Front Desk mirror's pure core (.github-private#704).
//
// Same posture as ci-state.test.ts: these pin the ways a board mirror LIES, not
// the happy path. Two failure classes are represented, and they are not equally
// bad.
//
//   1. Wrong board state — a stale card, a resurrected claim. Costs a session
//      some wasted work; reconcile repairs it.
//   2. A private repo's issue title on a public page. Cannot be walked back.
//
// The `toPublicSnapshot` block below is class 2, which is why it tests the
// filter from both directions — that permitted rows survive AND that every
// unpermitted shape drops — rather than only checking the happy case.

import { describe, test, expect } from "bun:test";
import {
  applyAll,
  applyItem,
  emptyBoard,
  removeItem,
  replaceAll,
  toSnapshot,
  toPublicSnapshot,
  stampRfc3339,
  isStale,
  type BoardItem,
} from "./desk-state";

const NOW = new Date("2026-08-25T01:30:00Z");

const item = (over: Partial<BoardItem> = {}): BoardItem => ({
  item_id: "PVTI_a",
  type: "Issue",
  repo: "bounded-systems/prx",
  repo_private: false,
  number: 1,
  title: "a title",
  url: "https://github.com/bounded-systems/prx/issues/1",
  issue_state: "OPEN",
  assignees: [],
  labels: [],
  claimed: false,
  fields: { Status: "Todo", Score: 10 },
  updated_at: "2026-08-25T01:00:00Z",
  ...over,
});

describe("applyItem — the fold", () => {
  test("a newer stamp replaces an older one", () => {
    const s = applyAll(emptyBoard(), [
      item({ updated_at: "2026-08-25T01:00:00Z", fields: { Status: "Todo" } }),
      item({ updated_at: "2026-08-25T01:05:00Z", fields: { Status: "In Progress" } }),
    ]);
    expect(s.items.PVTI_a.fields.Status).toBe("In Progress");
  });

  test("an OLDER stamp does not overwrite a newer one", () => {
    // The reordering bug that matters: webhook delivery is unordered and
    // reconcile replays history, so a late-arriving old edit must not resurrect
    // a claim that has since been released.
    const s = applyAll(emptyBoard(), [
      item({ updated_at: "2026-08-25T01:05:00Z", claimed: false }),
      item({ updated_at: "2026-08-25T01:00:00Z", claimed: true }),
    ]);
    expect(s.items.PVTI_a.claimed).toBe(false);
  });

  test("the fold is order-insensitive", () => {
    const a = item({ updated_at: "2026-08-25T01:00:00Z", fields: { Status: "Todo" } });
    const b = item({ updated_at: "2026-08-25T01:05:00Z", fields: { Status: "Done" } });
    expect(applyAll(emptyBoard(), [a, b])).toEqual(applyAll(emptyBoard(), [b, a]));
  });

  test("a tie resolves the same way whichever order it arrives in", () => {
    // `updated_at` is second-precision and not unique, so ties are real (unlike
    // ci-state, whose runId is unique per run). Keeping the incumbent felt
    // natural and was WRONG: it made the fold order-dependent, which the
    // property suite caught immediately. Which same-second edit "really" came
    // last is unknowable from the data; resolving CONSISTENTLY is what makes
    // the fold a join, and being a join is what makes the mirror converge.
    const first = item({ updated_at: "2026-08-25T01:00:00Z", title: "first" });
    const second = item({ updated_at: "2026-08-25T01:00:00Z", title: "second" });

    const forward = applyAll(emptyBoard(), [first, second]);
    const backward = applyAll(emptyBoard(), [second, first]);
    expect(forward).toEqual(backward);
  });

  test("an unparseable stamp is REJECTED, not treated as newest", () => {
    // Admitting it would let one malformed delivery overwrite good state
    // permanently. Reconcile repairs an omission; nothing repairs a bad write.
    const good = item({ title: "good" });
    for (const bad of ["", "not a date", "2026-13-45T99:99:99Z"]) {
      const s = applyAll(emptyBoard(), [good, item({ updated_at: bad, title: "bad" })]);
      expect(s.items.PVTI_a.title).toBe("good");
    }
  });

  test("an unparseable stamp cannot create an entry either", () => {
    expect(applyItem(emptyBoard(), item({ updated_at: "nope" })).items).toEqual({});
  });

  test("distinct item_ids coexist", () => {
    const s = applyAll(emptyBoard(), [item({ item_id: "A" }), item({ item_id: "B" })]);
    expect(Object.keys(s.items).sort()).toEqual(["A", "B"]);
  });
});

describe("removeItem and replaceAll", () => {
  test("remove drops a card that left the board", () => {
    const s = applyAll(emptyBoard(), [item()]);
    expect(removeItem(s, "PVTI_a").items).toEqual({});
  });

  test("removing an absent id is a no-op, not an error", () => {
    expect(removeItem(emptyBoard(), "nope").items).toEqual({});
  });

  test("replaceAll ERASES drift — the property a fold cannot give", () => {
    // The authority that makes the weaker updated_at ordering safe: reconcile
    // must be able to remove an item the webhook stream told us about but the
    // board no longer has.
    const drifted = applyAll(emptyBoard(), [item({ item_id: "ghost" }), item({ item_id: "real" })]);
    const reconciled = replaceAll([item({ item_id: "real" })]);
    expect(Object.keys(reconciled.items)).toEqual(["real"]);
    expect(Object.keys(drifted.items)).toContain("ghost");
  });
});

describe("toSnapshot", () => {
  test("stamps at second precision", () => {
    // Load-bearing: jq's fromdateiso8601 rejects fractional seconds, so a
    // millisecond stamp would make every snapshot parse as unanswered.
    const s = toSnapshot(emptyBoard(), { now: new Date("2026-08-25T01:30:00.456Z") });
    expect(s.generated_at).toBe("2026-08-25T01:30:00Z");
    expect(stampRfc3339(NOW)).toBe("2026-08-25T01:30:00Z");
  });

  test("counts by Status, and items with no Status are not silently dropped", () => {
    const s = toSnapshot(
      applyAll(emptyBoard(), [
        item({ item_id: "a", fields: { Status: "Todo" } }),
        item({ item_id: "b", fields: { Status: "Todo" } }),
        item({ item_id: "c", fields: { Status: "Done" } }),
        item({ item_id: "d", fields: {} }),
      ]),
      { now: NOW },
    );
    expect(s.counts).toEqual({ Todo: 2, Done: 1, "(no status)": 1 });
    expect(s.item_count).toBe(4);
  });

  test("item order is stable, so two renders of one state are identical", () => {
    const state = applyAll(emptyBoard(), [item({ item_id: "z" }), item({ item_id: "a" })]);
    expect(toSnapshot(state, { now: NOW }).items.map((i) => i.item_id)).toEqual(["a", "z"]);
  });

  test("the two data clocks are carried, and default to null rather than to now", () => {
    // The distinction between "the board is quiet" and "we have gone deaf".
    // Serving refreshes generated_at; these must come only from state (#276).
    const bare = toSnapshot(emptyBoard(), { now: NOW });
    expect(bare.last_event_at).toBeNull();
    expect(bare.last_reconciled_at).toBeNull();
    expect(bare.generated_at).not.toBeNull();

    const live = toSnapshot(emptyBoard(), {
      now: NOW,
      lastEventAt: "2026-08-25T01:29:00Z",
      lastReconciledAt: "2026-08-25T00:00:00Z",
    });
    expect(live.last_event_at).toBe("2026-08-25T01:29:00Z");
    expect(live.last_reconciled_at).toBe("2026-08-25T00:00:00Z");
  });

  test("head defaults to null — unverified must never read as fine", () => {
    expect(toSnapshot(emptyBoard(), { now: NOW }).head).toBeNull();
  });

  test("head is carried when the log supplies one", () => {
    const head = { tree_size: 42, root_hash: "abc", signed_at: "2026-08-25T01:29:00Z" };
    expect(toSnapshot(emptyBoard(), { now: NOW, head }).head).toEqual(head);
  });

  test("a missing stamp is stale, not fresh", () => {
    expect(isStale({}, NOW)).toBe(true);
  });
});

describe("toPublicSnapshot — default-deny, the failure that cannot be walked back", () => {
  const publish = (items: BoardItem[]) =>
    toPublicSnapshot(toSnapshot(applyAll(emptyBoard(), items), { now: NOW }));

  test("a positively-public row survives", () => {
    const out = publish([item({ item_id: "a", repo_private: false })]);
    expect(out.items.map((i) => i.item_id)).toEqual(["a"]);
  });

  test("private, unknown-visibility and repo-less rows ALL drop", () => {
    const out = publish([
      item({ item_id: "pub", repo_private: false }),
      item({ item_id: "priv", repo_private: true }),
      item({ item_id: "unknown", repo_private: null }),
      item({ item_id: "draft", repo: null, repo_private: null }),
    ]);
    expect(out.items.map((i) => i.item_id)).toEqual(["pub"]);
  });

  test("unknown visibility is not permission — the allowlist direction", () => {
    // A denylist (`!== true`) would publish this row. That difference is the
    // whole design, so it gets its own test rather than riding on the case above.
    expect(publish([item({ repo_private: null })]).items).toHaveLength(0);
  });

  test("item_count and counts describe the PUBLISHED rows, not the source", () => {
    // Count parity is what the projection lane asserts before pushing; if these
    // described the private snapshot a reader would over-trust the public feed.
    const out = publish([
      item({ item_id: "a", repo_private: false, fields: { Status: "Todo" } }),
      item({ item_id: "b", repo_private: true, fields: { Status: "Todo" } }),
    ]);
    expect(out.item_count).toBe(1);
    expect(out.counts).toEqual({ Todo: 1 });
  });

  test("fields are allowlisted — assignees and repo_private never ship", () => {
    const out = publish([
      item({ repo_private: false, assignees: ["someone"], labels: ["enhancement"] }),
    ]);
    const row = out.items[0] as Record<string, unknown>;
    expect(row.assignees).toBeUndefined();
    expect(row.repo_private).toBeUndefined();
    expect(row.labels).toEqual(["enhancement"]);
    expect(row.title).toBe("a title");
  });

  test("an unknown upstream field cannot ride along", () => {
    // The regression this guards is silent: a new board column or internal note
    // added upstream would otherwise be published by default.
    const sneaky = { ...item({ repo_private: false }), internal_note: "do not publish" };
    const out = publish([sneaky as BoardItem]);
    expect((out.items[0] as Record<string, unknown>).internal_note).toBeUndefined();
  });

  test("provenance survives the filter — an unverifiable public row is the point of failure", () => {
    const provenance = { leaf_index: 7, leaf_hash: "deadbeef", inclusion_proof: ["a", "b"] };
    const out = publish([item({ repo_private: false, provenance })]);
    expect(out.items[0].provenance).toEqual(provenance);
  });

  test("the head survives the filter, so a public reader can verify inclusion", () => {
    const head = { tree_size: 9, root_hash: "root", signed_at: "2026-08-25T01:29:00Z" };
    const snap = toSnapshot(applyAll(emptyBoard(), [item({ repo_private: false })]), {
      now: NOW,
      head,
    });
    expect(toPublicSnapshot(snap).head).toEqual(head);
  });

  test("re-filtering a published snapshot empties it — which is why the types forbid it", () => {
    // NOT idempotent, and must not be made so. The filter's INPUT
    // (`repo_private`) is stripped from its output by the allowlist, so a
    // second pass reads null on every row and default-deny correctly drops all
    // of them. front-desk-projection.yml records hitting exactly this shape:
    //
    //   "the public file strips repo_private by design, so asking it 'are all
    //    your rows non-private' reads null on every row and fires on VALID
    //    output. (It did, in testing — a guard that blocks every good publish
    //    is worse than none, because the fix is to delete it under pressure.)"
    //
    // The real defence is the type system: PublicSnapshot is not assignable to
    // Snapshot, so this line does not compile without the cast below. The cast
    // exists only to demonstrate what the compiler is protecting, and the
    // assertion is "you get nothing", never "you get the same thing".
    const once = publish([item({ repo_private: false })]);
    expect(once.items).toHaveLength(1);
    expect(toPublicSnapshot(once as never).items).toHaveLength(0);
  });
});
