// Tests for the Durable Object shell (.github-private#481).
//
// Scope, stated honestly: these cover the class's *logic* — routing, the
// load→apply→put sequence, the skip-write branch, and how snapshot coverage is
// parameterised. They do **not** cover the one property the DO actually exists
// to provide, per-object serialization of read-modify-write. That is Cloudflare's
// runtime guarantee, not this class's code, and it is the discharge obligation
// already recorded against the confluence proof in bounded-systems/proofs
// (`ci-state/CiState.lean`): confluence covers reordering, serialization covers
// lost updates, and neither subsumes the other.
//
// Storage is stubbed rather than run under workerd because the class is
// deliberately thin — one dependency, one key. A stub that counts writes is
// enough to pin the branch that matters, and it runs in the same `bun test`
// lane as everything else.

import { describe, test, expect } from "bun:test";
import { CiStateDO } from "./ci-do";
import type { Observation } from "./ci-state";

/** Minimal DurableObjectState double: one in-memory map, plus a write counter
 *  so "did it skip the write?" is observable rather than inferred. */
function stubState() {
  const map = new Map<string, unknown>();
  let writes = 0;
  const state = {
    storage: {
      get: async <T>(key: string): Promise<T | undefined> => map.get(key) as T | undefined,
      put: async (key: string, value: unknown): Promise<void> => {
        writes++;
        map.set(key, value);
      },
    },
  };
  return { state, writes: () => writes };
}

const doFor = () => {
  const { state, writes } = stubState();
  return { obj: new CiStateDO(state as unknown as DurableObjectState), writes };
};

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

const observe = (obj: CiStateDO, o: Observation) =>
  obj.fetch(new Request("https://ci/observe", { method: "POST", body: JSON.stringify(o) }));

const snapshot = async (obj: CiStateDO, qs = "") => {
  const res = await obj.fetch(new Request(`https://ci/snapshot${qs}`));
  return res.json() as Promise<{
    repos_known: number | null;
    repos_observed: number;
    coverage_complete: boolean;
    unobserved: string[];
    red: { repo: string; workflow: string; conclusion: string }[];
  }>;
};

describe("CiStateDO", () => {
  test("ingests an observation and reports it stored", async () => {
    const { obj } = doFor();
    const res = await observe(obj, obs());
    expect(await res.json()).toEqual({ stored: true });
    expect((await snapshot(obj)).repos_observed).toBe(1);
  });

  test("starts from empty storage without blowing up", async () => {
    const { obj } = doFor();
    const snap = await snapshot(obj);
    expect(snap.repos_observed).toBe(0);
    expect(snap.red).toEqual([]);
  });

  // The branch worth pinning: the reconcile poll replays history on every pass,
  // so if a no-op observation still wrote, the DO would rewrite its whole state
  // on a schedule forever.
  test("skips the write for a replayed observation", async () => {
    const { obj, writes } = doFor();
    await observe(obj, obs({ runId: 100 }));
    expect(writes()).toBe(1);

    const again = await observe(obj, obs({ runId: 100 }));
    expect(await again.json()).toEqual({ stored: false });
    expect(writes()).toBe(1);
  });

  test("skips the write for a stale run, keeping the newer verdict", async () => {
    const { obj, writes } = doFor();
    await observe(obj, obs({ runId: 101, conclusion: "failure" }));
    const stale = await observe(obj, obs({ runId: 100, conclusion: "success" }));

    expect(await stale.json()).toEqual({ stored: false });
    expect(writes()).toBe(1);
    const snap = await snapshot(obj);
    expect(snap.red).toHaveLength(1);
    expect(snap.red[0]!.conclusion).toBe("failure");
  });

  test("persists across calls — a later snapshot sees earlier observations", async () => {
    const { obj } = doFor();
    await observe(obj, obs({ repo: "o/a", workflow: "standard" }));
    await observe(obj, obs({ repo: "o/b", workflow: "release", conclusion: "startup_failure" }));

    const snap = await snapshot(obj);
    expect(snap.repos_observed).toBe(2);
    expect(snap.red.map((r) => r.repo)).toEqual(["o/b"]);
  });

  // Coverage is a caller-supplied denominator on purpose: inferring it from what
  // has reported in would make a fleet that reported nothing claim to know of
  // nothing, i.e. look complete exactly when it is worst.
  test("reports coverage unknown when no reposKnown is supplied", async () => {
    const { obj } = doFor();
    await observe(obj, obs({ repo: "o/a" }));

    const snap = await snapshot(obj);
    expect(snap.repos_known).toBeNull();
    expect(snap.coverage_complete).toBe(false);
  });

  test("reports partial coverage and names the unobserved repos", async () => {
    const { obj } = doFor();
    await observe(obj, obs({ repo: "o/a" }));

    const snap = await snapshot(obj, "?reposKnown=o%2Fa,o%2Fb,o%2Fc");
    expect(snap.repos_known).toBe(3);
    expect(snap.repos_observed).toBe(1);
    expect(snap.unobserved).toEqual(["o/b", "o/c"]);
    expect(snap.coverage_complete).toBe(false);
  });

  test("reports complete coverage only when every known repo was observed", async () => {
    const { obj } = doFor();
    await observe(obj, obs({ repo: "o/a" }));
    await observe(obj, obs({ repo: "o/b" }));

    const snap = await snapshot(obj, "?reposKnown=o%2Fa,o%2Fb");
    expect(snap.coverage_complete).toBe(true);
    expect(snap.unobserved).toEqual([]);
  });

  // An empty `reposKnown=` must not read as "zero repos known, therefore
  // complete" — that would turn a misconfigured var into a false all-green.
  test("an empty reposKnown parameter is treated as unknown, not as zero repos", async () => {
    const { obj } = doFor();
    await observe(obj, obs());

    const snap = await snapshot(obj, "?reposKnown=");
    expect(snap.repos_known).toBeNull();
    expect(snap.coverage_complete).toBe(false);
  });

  test("unknown routes 404 rather than falling through to a handler", async () => {
    const { obj } = doFor();
    expect((await obj.fetch(new Request("https://ci/nope"))).status).toBe(404);
    // Right path, wrong method — must not be treated as an observe.
    expect((await obj.fetch(new Request("https://ci/observe"))).status).toBe(404);
  });
});

// ── the keeper-approval replay guard (.github-private#847) ──────────────────
// The route's signature window is ±300 s, which alone would let a captured
// notice fire duplicate wake-ups for five minutes. This endpoint is what makes
// a ceremony id spendable exactly once.

const seen = (obj: CiStateDO, ceremonyId: unknown) =>
  obj.fetch(new Request("https://ci/keeper-seen", { method: "POST", body: JSON.stringify({ ceremonyId }) }));

test("a ceremony id can be claimed once, and the second claim is 409", async () => {
  const { obj } = doFor();
  expect((await seen(obj, "cer-abcdefgh")).status).toBe(200);
  expect((await seen(obj, "cer-abcdefgh")).status).toBe(409);
});

test("distinct ceremony ids do not collide", async () => {
  const { obj } = doFor();
  for (const id of ["cer-one", "cer-two", "cer-three"]) {
    expect((await seen(obj, id)).status).toBe(200);
  }
});

test("a missing or malformed ceremonyId is 400 — never a silent pass", async () => {
  const { obj } = doFor();
  for (const bad of [undefined, "", 42, null]) {
    expect((await seen(obj, bad)).status).toBe(400);
  }
});

test("the route EXISTS — a 404 here would mean the replay check passes everything", async () => {
  // The defect this pins is the one that nearly shipped: worker.ts treats
  // "not 409" as "not seen", so a MISSING route would have silently disabled
  // the guard rather than failing loudly. Asserting the status is not 404 is
  // asserting that the endpoint the route depends on is actually wired.
  const { obj } = doFor();
  expect((await seen(obj, "cer-x1234567")).status).not.toBe(404);
});
