// CiStateDO — the Durable Object holding fleet CI state (.github-private#481).
//
// Deliberately thin. Every decision that could be wrong lives in ci-state.ts,
// which is pure and tested; this class contributes exactly one property that a
// pure function cannot: **serialized read-modify-write**.
//
// That property is the whole reason for a DO here rather than KV. Roughly 88
// repos deliver `workflow_run` concurrently, and each delivery is a
// read-modify-write of shared state. KV is eventually consistent and
// last-write-wins, so two deliveries landing together silently drop one — and
// the one dropped is as likely as not the red we exist to catch. A DO handles
// one request at a time per object, so the interleaving cannot happen.
//
// Consequently there is one object (a single named instance), not one per repo:
// sharding by repo would restore exactly the cross-repo race we are avoiding
// when the snapshot is assembled.

import {
  applyObservation,
  emptyState,
  toSnapshot,
  type CiState,
  type Observation,
} from "./ci-state";

const STATE_KEY = "ci-state";
const REPOS_KNOWN_KEY = "repos-known";

type ReposKnownRecord = { repos: string[]; observed_at: string };

export class CiStateDO {
  constructor(private state: DurableObjectState) {}

  private async load(): Promise<CiState> {
    return (await this.state.storage.get<CiState>(STATE_KEY)) ?? emptyState();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // CLAIM A CEREMONY ID, ONCE. The keeper-approval route's replay refusal
    // (`.github-private`#847): its signature window is ±300 s, which alone
    // would let a captured notice fire duplicate wake-ups for five minutes.
    //
    // Correct BECAUSE the DO serializes: get-then-put is only atomic here, and
    // the whole value of this endpoint is that two concurrent notices for one
    // ceremony cannot both see "absent". A KV would race.
    //
    // Answers 409 for a repeat, 200 for a first claim -- and NOTHING ELSE, so a
    // caller that treats "not 409" as "go ahead" is right. A 404 from a missing
    // route would have meant this check silently passed everything, which is the
    // failure this endpoint exists to make impossible.
    if (url.pathname === "/keeper-seen" && request.method === "POST") {
      const { ceremonyId } = (await request.json()) as { ceremonyId?: string };
      if (typeof ceremonyId !== "string" || ceremonyId.length === 0) {
        return new Response("missing ceremonyId", { status: 400 });
      }
      const key = `keeper-seen:${ceremonyId}`;
      if (await this.state.storage.get(key)) return new Response("duplicate", { status: 409 });
      // A ceremony id is spent once and never reused, so this only ever grows
      // by one row per approval. Expiry is not needed for correctness; if the
      // row count ever matters, delete by age rather than weakening the check.
      await this.state.storage.put(key, Date.now());
      return new Response("claimed");
    }

    // Ingest one observation. The load → apply → put sequence is only safe
    // because the DO serializes it; that is the point of this class.
    if (url.pathname === "/observe" && request.method === "POST") {
      const observation = (await request.json()) as Observation;
      const before = await this.load();
      const after = applyObservation(before, observation);
      // applyObservation is a no-op for a stale or duplicate run, and skipping
      // the write in that case keeps replays of the reconcile poll from
      // rewriting storage on every pass.
      if (after !== before) await this.state.storage.put(STATE_KEY, after);
      return Response.json({ stored: after !== before });
    }

    // The reconcile cron's write: the App's installation list, the only honest
    // coverage denominator. An empty list is REFUSED — writing it would flip
    // the snapshot from "coverage unknown" to "coverage complete over nothing",
    // the cheerful-green failure the whole contract exists to prevent; an empty
    // fetch result means something upstream broke, and unknown is the truthful
    // report of that.
    if (url.pathname === "/reposKnown" && request.method === "POST") {
      const body = (await request.json()) as { repos?: unknown };
      const repos = Array.isArray(body.repos)
        ? body.repos.filter((r): r is string => typeof r === "string" && r.length > 0)
        : [];
      if (repos.length === 0) {
        return Response.json({ stored: false, reason: "empty repo list refused" }, { status: 400 });
      }
      const record: ReposKnownRecord = { repos, observed_at: new Date().toISOString() };
      await this.state.storage.put(REPOS_KNOWN_KEY, record);
      return Response.json({ stored: true, count: repos.length });
    }

    if (url.pathname === "/snapshot" && request.method === "GET") {
      // `reposKnown` is supplied, never inferred from who has reported in —
      // inferring it would make coverage look complete exactly when it is
      // worst, because a fleet that has reported nothing would claim to know
      // of nothing. Precedence: the caller's explicit query (the CI_REPOS_KNOWN
      // var, a manual override) wins; otherwise the reconcile cron's stored
      // installation list; otherwise undefined and coverage reports unknown.
      const raw = url.searchParams.get("reposKnown");
      let reposKnown = raw ? raw.split(",").filter(Boolean) : undefined;
      if (!reposKnown) {
        const rec = await this.state.storage.get<ReposKnownRecord>(REPOS_KNOWN_KEY);
        reposKnown = rec?.repos;
      }
      const state = await this.load();
      return Response.json(toSnapshot(state, { now: new Date(), reposKnown }));
    }

    return new Response("not found", { status: 404 });
  }
}
