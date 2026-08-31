import { describe, test, expect } from "bun:test";
import { decide, dispatch, type DispatchTarget } from "./dispatch-events";

// The load-bearing cases are the REFUSALS and the fan-out.
//
// Refusals, because this sender's whole reason for existing is that a silent
// one is invisible: the ABSENT sender went unnoticed for weeks precisely
// because nothing reported the path was cold (.github-private#779). A skip has
// to be a countable reason, not a bare null.
//
// Fan-out, because waking one consumer and not the other fixes half the
// symptom — and the half left broken is the PUBLIC feed, which is where the
// wrong number was actually read.

const targets = (r: ReturnType<typeof decide>) =>
  r.ok ? r.targets.map((t) => `${t.repo}:${t.eventType}`).sort() : [];

describe("decide — which deliveries wake a projection", () => {
  test("an unwatched event is skipped with a reason, not silently", () => {
    const r = decide("workflow_run", "completed");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("event-not-watched");
  });

  test("workflow_run in particular stays with the CI aggregator", () => {
    // It is the one event this Worker already handles, for a different purpose.
    // Waking a projection on it too would fire on every CI run in the org.
    expect(decide("workflow_run", "completed").ok).toBe(false);
  });

  test("a null event (absent header) is skipped, not treated as a default", () => {
    const r = decide(null, "opened");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("event-not-watched");
  });

  test("a watched event with no action is skipped rather than assumed", () => {
    const r = decide("pull_request", undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-action");
  });
});

describe("pull_request", () => {
  test("the four open/closed transitions fan out to both consumers", () => {
    for (const action of ["opened", "closed", "reopened", "ready_for_review"]) {
      expect(targets(decide("pull_request", action))).toEqual([
        ".github-private:pr-activity",
        "front-desk-feed:pr-activity",
      ]);
    }
  });

  test("synchronize does NOT wake anything", () => {
    // The highest-volume PR action there is, and it changes nothing the feed
    // shows. Firing on it would put a projection run behind every push to
    // every open PR in the org.
    const r = decide("pull_request", "synchronize");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("action-not-watched");
  });

  test("neither do the review and label actions on a PR", () => {
    for (const action of ["labeled", "review_requested", "edited", "synchronize"]) {
      expect(decide("pull_request", action).ok).toBe(false);
    }
  });
});

describe("issues — a claim IS the label or the assignee", () => {
  test("label and assignee actions wake the claim path", () => {
    // .github#282: `pr-claim` reads the LABEL or the ASSIGNEE. So these four
    // actions are the claim signal; without them a claim taken by hand is
    // invisible until the next cron slot that happens to fire.
    for (const action of ["labeled", "unlabeled", "assigned", "unassigned"]) {
      expect(targets(decide("issues", action))).toEqual([
        ".github-private:claim-activity",
        "front-desk-feed:claim-activity",
      ]);
    }
  });

  test("open/close/reopen wake it too — they change what is claimable", () => {
    for (const action of ["opened", "closed", "reopened"]) {
      expect(decide("issues", action).ok).toBe(true);
    }
  });

  test("an issue body edit does not", () => {
    expect(decide("issues", "edited").ok).toBe(false);
  });
});

describe("projects_v2_item — the signal that reaches no other event", () => {
  test("card edits wake BOTH board consumers", () => {
    // This pinned `.github-private` alone, on the belief that the public feed
    // derives from the board projection and so a second wake-up would be a
    // second path to the same answer. There is no first path: front-desk-feed's
    // publish.yml queries org project #2 itself, and its own `on:` block records
    // that dispatching the private projection lane leaves this feed untouched.
    // The assertion was pinning the bug in place, which is why it changes here
    // rather than being deleted as an obstacle.
    expect(targets(decide("projects_v2_item", "edited"))).toEqual([
      ".github-private:board-changed",
      "front-desk-feed:board-changed",
    ]);
  });

  test("every card lifecycle action reaches both, not just `edited`", () => {
    // `ok: true` was too weak to catch the missing target — it passed
    // throughout the window where a card move reached the public feed through
    // no path at all. Assert the fan-out per action instead.
    for (const action of ["created", "edited", "deleted", "reordered", "restored"]) {
      expect(targets(decide("projects_v2_item", action))).toEqual([
        ".github-private:board-changed",
        "front-desk-feed:board-changed",
      ]);
    }
  });

  test("an unknown future action is skipped rather than assumed harmless", () => {
    // Widening must be a visible edit here, not something GitHub does for us by
    // adding an action to an event we already subscribe to.
    expect(decide("projects_v2_item", "archived_somehow").ok).toBe(false);
  });
});

describe("front-desk-feed — the branch a reader actually looks at", () => {
  test("every type this sender can send wakes the feed, none private-only", () => {
    // Pinned across the whole DispatchType union rather than case by case,
    // because the defect was never one wrong line — it was a type that quietly
    // had one consumer fewer than the others. desk.bounded.tools renders the
    // `feed` branch and now pushes on a board change, so a type that wakes only
    // the private side puts a notification in front of a board that has not
    // moved yet. A fourth type should fail here until someone has decided, in
    // the open, whether the public feed needs it.
    const woken = new Set<string>();
    for (const [event, action] of [
      ["pull_request", "opened"],
      ["issues", "labeled"],
      ["projects_v2_item", "edited"],
    ] as const) {
      const r = decide(event, action);
      expect(r.ok).toBe(true);
      if (r.ok) for (const t of r.targets) if (t.repo === "front-desk-feed") woken.add(t.eventType);
    }
    expect([...woken].sort()).toEqual(["board-changed", "claim-activity", "pr-activity"]);
  });
});

describe("dispatch — transport", () => {
  const target: DispatchTarget = { owner: "bounded-systems", repo: ".github-private", eventType: "board-changed" };

  test("posts the event_type to the repo's dispatches endpoint", async () => {
    let captured: { url: string; body: unknown; auth: string | null } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = {
        url: String(url),
        body: JSON.parse(String(init.body)),
        auth: (init.headers as Record<string, string>).authorization
          ?? (init.headers as Record<string, string>).Authorization
          ?? null,
      };
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const out = await dispatch(target, "ghs_tok", fetchImpl);
    expect(out.ok).toBe(true);
    expect(out.status).toBe(204);
    expect(captured!.url).toBe("https://api.github.com/repos/bounded-systems/.github-private/dispatches");
    expect(captured!.body).toEqual({ event_type: "board-changed" });
    expect(captured!.auth).toBe("Bearer ghs_tok");
  });

  test("a GitHub refusal is reported, not thrown", async () => {
    const fetchImpl = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    const out = await dispatch(target, "ghs_tok", fetchImpl);
    expect(out.ok).toBe(false);
    expect(out.status).toBe(403);
  });

  test("a network failure is reported as status 0, not thrown", async () => {
    // A handler that throws gets its delivery marked failed, and enough failed
    // deliveries get the whole webhook disabled by GitHub — losing the events
    // that still work in order to report the one that did not. Status 0 keeps
    // "GitHub said no" and "we could not reach GitHub" apart, because they are
    // different fixes in different places.
    const fetchImpl = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    const out = await dispatch(target, "ghs_tok", fetchImpl);
    expect(out.ok).toBe(false);
    expect(out.status).toBe(0);
  });
});
