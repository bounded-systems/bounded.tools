// dispatch-events — pure adapter from a GitHub webhook delivery to a
// `repository_dispatch` that wakes a projection (.github-private#779).
//
// WHY THIS EXISTS. The Front Desk projections declare `repository_dispatch`
// receivers and have never received one: no sender was ever built. They
// therefore run on cron alone, and an hourly cron on GitHub Actions is not a
// delivery guarantee — measured over 106 hours, the board projection took 36 of
// ~106 slots (~34%), while the one DAILY lane in the same repo took ~98% of
// its. The board consequently read 6h46m stale on 2026-08-29
// (.github-private#801), and a session cannot read the board any other way.
//
// Same shape as github-events.ts and for the same reason: the judgement —
// which deliveries wake a projection, which are ignored, and why — is testable
// without a runtime, a signature, or a network. The Worker does transport.
//
// Every rejection returns a REASON rather than a bare null. A sender that
// silently drops deliveries is indistinguishable from a quiet org, and that is
// precisely how the ABSENT sender stayed invisible for weeks: nothing reported
// that the path was cold.

/** The dispatch types the existing receivers already accept. These are not new
 *  names — `pr-activity` and `claim-activity` are declared today in
 *  `.github-private`'s `pr-projection.yml` and `front-desk-feed`'s
 *  `publish.yml`, and have simply never been sent. `board-changed` was the one
 *  addition, for ProjectV2 edits, which no receiver could observe before; both
 *  receivers declare it now. */
export type DispatchType = "pr-activity" | "claim-activity" | "board-changed";

export type DispatchTarget = { owner: string; repo: string; eventType: DispatchType };

export type DecideResult =
  | { ok: true; targets: DispatchTarget[] }
  | { ok: false; reason: SkipReason };

export type SkipReason =
  | "event-not-watched"
  | "action-not-watched"
  | "no-action";

const OWNER = "bounded-systems";

// WHICH ACTIONS. Narrow on purpose: an action not named here cannot wake a
// projection, so widening is a visible edit rather than a side effect of
// GitHub adding a new action to an event we already subscribe to.
//
// `pull_request` — the four that change whether a PR is open, which is the only
// thing the PR feed projects. Notably NOT `synchronize`: a push to an open PR
// changes nothing the feed shows, and it is the highest-volume action there is.
const PR_ACTIONS = new Set(["opened", "closed", "reopened", "ready_for_review"]);

// `issues` — open/close changes what is claimable; the label and assignee
// actions ARE the claim signal, because a claim IS the `claimed` label or an
// assignee (.github#282). Nothing else on an issue moves the board.
const ISSUE_ACTIONS = new Set([
  "opened", "closed", "reopened",
  "labeled", "unlabeled", "assigned", "unassigned",
]);

// `projects_v2_item` — the direct "the board changed" signal: card moves and
// field edits (Status, Score), which reach no other event. `edited` is the
// high-volume one and is the point: a Status drag is exactly the change that
// used to wait up to six hours.
const PROJECT_ITEM_ACTIONS = new Set(["created", "edited", "deleted", "reordered", "restored"]);

/** Where each signal has to land. Two repos, and both are required — which is
 *  why the dispatch App is installed on exactly these two and no others.
 *
 *  `.github-private` holds the private projections a session reads;
 *  `front-desk-feed` publishes the public feed at prs.bounded.tools, whose
 *  "The backlog is drained" was false for a whole window while 88 PRs were
 *  open — and the `feed` branch it force-pushes is also what desk.bounded.tools
 *  renders as the board. Waking one and not the other fixes half the symptom,
 *  and the half left broken is the one a reader is actually looking at. */
export function decide(event: string | null, action: string | undefined): DecideResult {
  const fanout = (eventType: DispatchType, repos: string[]): DecideResult => ({
    ok: true,
    targets: repos.map((repo) => ({ owner: OWNER, repo, eventType })),
  });

  switch (event) {
    case "pull_request":
      if (!action) return { ok: false, reason: "no-action" };
      if (!PR_ACTIONS.has(action)) return { ok: false, reason: "action-not-watched" };
      return fanout("pr-activity", [".github-private", "front-desk-feed"]);

    case "issues":
      if (!action) return { ok: false, reason: "no-action" };
      if (!ISSUE_ACTIONS.has(action)) return { ok: false, reason: "action-not-watched" };
      return fanout("claim-activity", [".github-private", "front-desk-feed"]);

    case "projects_v2_item":
      if (!action) return { ok: false, reason: "no-action" };
      if (!PROJECT_ITEM_ACTIONS.has(action)) return { ok: false, reason: "action-not-watched" };
      // BOTH — and this said private-side only, on a premise that was simply
      // wrong: "the public feed derives from [the board projection] rather than
      // from ProjectV2 directly". It does not. `front-desk-feed`'s publish.yml
      // runs its own `scripts/project.sh` against org project #2, and its `on:`
      // block says so in as many words: dispatching `.github-private`'s
      // front-desk-projection.yml "does NOT refresh this feed … different repo,
      // different branch". So a board change woke the private lane and reached
      // the public one through no path at all — the same hole the absent sender
      // had, one event further in.
      //
      // Measured 2026-08-30: the board projection updated at 22:52 and
      // desk.bounded.tools went on serving the 21:25 snapshot. That was merely
      // stale until desk gained Web Push. Now a board change also sends a
      // payload-less push whose service worker fetches the board to learn what
      // it was about — so an unwoken feed makes the notification actively
      // wrong: it says the board changed and hands the reader a board that has
      // not. Worse than not notifying.
      return fanout("board-changed", [".github-private", "front-desk-feed"]);

    default:
      return { ok: false, reason: "event-not-watched" };
  }
}

export type DispatchOutcome = { target: DispatchTarget; ok: boolean; status: number };

/** Fire one `repository_dispatch`. Returns the outcome rather than throwing:
 *  a webhook handler that throws gets its delivery marked failed, and enough
 *  failures get the whole webhook disabled by GitHub — losing the events that
 *  still work in order to report the one that did not. */
export async function dispatch(
  target: DispatchTarget,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DispatchOutcome> {
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${target.owner}/${target.repo}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "bounded-tools-dispatch",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ event_type: target.eventType }),
      },
    );
    return { target, ok: res.ok, status: res.status };
  } catch {
    // Network-shaped failure. Status 0 distinguishes it from a GitHub refusal,
    // which is a different fix in a different place.
    return { target, ok: false, status: 0 };
  }
}
