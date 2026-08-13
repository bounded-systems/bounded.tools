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

export class CiStateDO {
  constructor(private state: DurableObjectState) {}

  private async load(): Promise<CiState> {
    return (await this.state.storage.get<CiState>(STATE_KEY)) ?? emptyState();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

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

    if (url.pathname === "/snapshot" && request.method === "GET") {
      // `reposKnown` is supplied by the caller (the App's installation list),
      // not inferred from what has reported in — inferring it would make
      // coverage look complete exactly when it is worst, because a fleet that
      // has reported nothing would claim to know of nothing.
      const raw = url.searchParams.get("reposKnown");
      const reposKnown = raw ? raw.split(",").filter(Boolean) : undefined;
      const state = await this.load();
      return Response.json(toSnapshot(state, { now: new Date(), reposKnown }));
    }

    return new Response("not found", { status: 404 });
  }
}
