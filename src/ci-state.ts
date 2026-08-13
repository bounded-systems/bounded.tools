// ci-state — the pure core of the fleet CI aggregator (.github-private#481).
//
// Deliberately free of Cloudflare, GitHub and network: observations in, snapshot
// out, `now` injected. The runtime question (Bun.serve today, Workers + a Durable
// Object if we want serialized writes) is still open, and this file is the part
// that does not care which way it goes.
//
// What it is defending against is not "we lack a dashboard". It is the specific
// way a monitor lies:
//
//   - a repo nobody pushed to emits nothing, and silence reads as health;
//   - a partial sweep reports "3 red" and is heard as "the fleet has 3 red"
//     (the sweep that produced #481 covered 4 of 88 repos);
//   - a stuck snapshot serves a cheerful green forever, and because a parseable
//     snapshot ends the probe, it SUPPRESSES the checks that would disagree.
//
// So the type makes "unobserved" a first-class answer that is neither red nor
// green, and the snapshot always carries its own coverage and freshness.

/** How a run ended, in GitHub's vocabulary. `null` = still running. */
export type Conclusion =
  | "success"
  | "failure"
  | "startup_failure"
  | "timed_out"
  | "cancelled"
  | "skipped"
  | "neutral"
  | "action_required"
  | "stale"
  | null;

/** Conclusions that mean "this workflow is broken".
 *
 *  `startup_failure` is in here on purpose and is the reason this project
 *  exists: claude-box's release.yml returned it on ~95 consecutive pushes over
 *  two months (claude-box#254). It never schedules a job, so it produces no job
 *  log and is invisible to anything that only reads job results.
 *
 *  `cancelled` and `skipped` are NOT red — both are routinely deliberate
 *  (superseded runs, path filters), and a monitor that cries wolf on them gets
 *  muted, which is the same outcome as not having one. */
const RED: ReadonlySet<string> = new Set([
  "failure",
  "startup_failure",
  "timed_out",
  "action_required",
]);

/** One run of one workflow, on one repo's default branch. */
export type Observation = {
  repo: string; // "owner/name"
  workflow: string; // workflow name ("standard", "release")
  runId: number; // GitHub's run id — the ordering key, see applyObservation
  conclusion: Conclusion;
  sha: string;
  runUrl: string;
  observedAt: string; // RFC 3339 UTC, when the run reached this conclusion
};

export type CiState = {
  /** Keyed `repo::workflow`. One entry per workflow, holding only its newest run. */
  entries: Record<string, Observation>;
};

export const emptyState = (): CiState => ({ entries: {} });

const keyOf = (o: Pick<Observation, "repo" | "workflow">) => `${o.repo}::${o.workflow}`;

/** Fold one observation in, newest-run-wins.
 *
 *  Ordering is by `runId`, not by timestamp. Webhook delivery is not ordered and
 *  the reconcile poll replays history, so a late-arriving OLD run must not
 *  overwrite a newer one — that would resurrect a fixed failure, or worse, bury
 *  a live one under a stale success. Run ids are monotonic within a repo, which
 *  is all we need since the key is per (repo, workflow).
 *
 *  A run that hasn't concluded (`conclusion: null`) is ignored entirely rather
 *  than recorded as "not red": an in-flight run tells us nothing new, and
 *  storing it would drop the last known verdict on the floor. */
export function applyObservation(state: CiState, obs: Observation): CiState {
  if (obs.conclusion === null) return state;
  const key = keyOf(obs);
  const prev = state.entries[key];
  if (prev && prev.runId >= obs.runId) return state;
  return { entries: { ...state.entries, [key]: obs } };
}

export function applyAll(state: CiState, observations: readonly Observation[]): CiState {
  return observations.reduce(applyObservation, state);
}

/** RFC 3339 UTC at SECOND precision.
 *
 *  The truncation is load-bearing, not cosmetic. `status-probe.sh` parses this
 *  with jq's `fromdateiso8601`, which REJECTS fractional seconds — a snapshot
 *  stamped with milliseconds fails to parse, and an unparseable stamp is treated
 *  as unanswered. So emitting `toISOString()` directly would make every snapshot
 *  we ever served count as stale. Pinned by a test; see the same note in
 *  docs/handoffs/service-status-layer.md. */
export function stampRfc3339(now: Date): string {
  return `${now.toISOString().slice(0, 19)}Z`;
}

export type RedEntry = {
  repo: string;
  workflow: string;
  conclusion: string;
  sha: string;
  run_url: string;
  since: string;
};

export type Snapshot = {
  generated_at: string;
  /** Repos the App can see. `null` when the installation list was unavailable —
   *  see `coverage_complete`. */
  repos_known: number | null;
  /** Repos we hold at least one concluded run for. */
  repos_observed: number;
  /** False whenever coverage is partial or unknown. A consumer must not render
   *  "all green" off a snapshot with this false — it has not seen the fleet. */
  coverage_complete: boolean;
  /** Repos in `repos_known` we have never observed. Silence is not health, so
   *  these are named rather than counted as green. */
  unobserved: string[];
  red: RedEntry[];
  green_workflows: number;
};

export type SnapshotInput = {
  now: Date;
  /** Every repo the App is installed on. Omit only when that list could not be
   *  fetched — the snapshot then reports coverage as unknown rather than
   *  guessing it from whatever happened to report in. */
  reposKnown?: readonly string[];
};

/** Render state as the `/ci.json` body.
 *
 *  Every field a consumer needs to distrust this is present: when it was
 *  observed, how much of the fleet it covers, and which repos it has never heard
 *  from. A caller that ignores all three can still be misled, but it can no
 *  longer be misled *by accident*. */
export function toSnapshot(state: CiState, input: SnapshotInput): Snapshot {
  const entries = Object.values(state.entries);
  const observedRepos = new Set(entries.map((e) => e.repo));

  const red = entries
    .filter((e) => e.conclusion !== null && RED.has(e.conclusion))
    .map(
      (e): RedEntry => ({
        repo: e.repo,
        workflow: e.workflow,
        conclusion: e.conclusion as string,
        sha: e.sha,
        run_url: e.runUrl,
        since: e.observedAt,
      }),
    )
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.workflow.localeCompare(b.workflow));

  const known = input.reposKnown;
  const unobserved = known ? known.filter((r) => !observedRepos.has(r)).sort() : [];

  return {
    generated_at: stampRfc3339(input.now),
    repos_known: known ? known.length : null,
    repos_observed: observedRepos.size,
    // Unknown coverage is NOT complete coverage. Both the missing-list case and
    // the partial case land here, so a consumer has one flag to check.
    coverage_complete: known ? unobserved.length === 0 : false,
    unobserved,
    red,
    green_workflows: entries.filter((e) => e.conclusion === "success").length,
  };
}

/** Age of a snapshot in seconds, for the staleness rule consumers enforce.
 *  Returns `null` for a missing or unparseable stamp — which callers must treat
 *  as stale, never as fresh. */
export function snapshotAgeSeconds(snapshot: { generated_at?: string }, now: Date): number | null {
  const raw = snapshot.generated_at;
  if (!raw) return null;
  const then = Date.parse(raw);
  if (Number.isNaN(then)) return null;
  return Math.floor((now.getTime() - then) / 1000);
}

/** The staleness threshold consumers apply, mirroring status-probe's rule:
 *  older than this is *unanswered*, not healthy. */
export const STALE_AFTER_SECONDS = 600;

export function isStale(snapshot: { generated_at?: string }, now: Date): boolean {
  const age = snapshotAgeSeconds(snapshot, now);
  return age === null || age > STALE_AFTER_SECONDS;
}
