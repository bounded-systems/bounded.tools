// desk-state — the pure core of the Front Desk board mirror (.github-private#704).
//
// Same shape as ci-state.ts and for the same reasons: no Cloudflare, no GitHub,
// no network, `now` injected. Observations in, snapshot out. That file's header
// explains the posture; this one records only what differs, because the board
// is not CI and two of the differences are load-bearing.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// The board lives in org project #2 and a session cannot read it: there is no
// Projects tool on the session surface and no `gh` in the container (#431). So
// front-desk-projection.yml polls it hourly on Actions and force-pushes a JSON
// snapshot to a branch. That lane is 581 min/month, its sibling sweep is 1,768,
// and together they are the #2 and #7 consumers of a private Actions allowance
// the org exceeds ~3.4x — which is what stopped every private repo for 16h on
// 2026-08-24 (#467). Moving the board here deletes both lanes, and the board
// stops being able to freeze silently when Actions does.
//
// ── Difference 1: the ordering key is weaker than CI's, on purpose ──────────
// ci-state orders by `runId` because run ids are monotonic. The board has no
// such counter — `projects_v2_item` deliveries carry only `updated_at`. So this
// folds newest-`updatedAt`-wins, and that is genuinely weaker: two edits inside
// the same second, or a clock skew at the source, can invert.
//
// The repair is not a cleverer key, it is reconcile. A full board read is
// authoritative and REPLACES state wholesale (`replaceAll`), so any inversion
// survives at most until the next reconcile pass. Stated plainly because the
// asymmetry matters: webhook order is best-effort, reconcile is truth.
//
// ── Difference 2: unknown visibility is not permission ──────────────────────
// A CI snapshot that is wrong costs a wrong colour on a dashboard. A board
// snapshot that is wrong can put a PRIVATE REPO'S ISSUE TITLE on a public page,
// which cannot be walked back. `toPublicSnapshot` is therefore default-deny in
// both dimensions — rows AND fields — porting front-desk-public.sh's contract
// (#651, site#205) exactly rather than approximating it.

import { stampRfc3339, snapshotAgeSeconds, isStale } from "./ci-state";

// Re-exported rather than re-implemented. These three are generic (a stamp and
// its staleness rule) and their second-precision truncation is load-bearing —
// jq's `fromdateiso8601` rejects fractional seconds, so a duplicated copy that
// drifted would make every snapshot we serve parse as unanswered. When ci-state
// is next touched for its own reasons they belong in a shared module; doing that
// refactor here would put a live production Worker at risk for a cosmetic win.
export { stampRfc3339, snapshotAgeSeconds, isStale };

/** Board Status column. User-defined on the project, so this is deliberately a
 *  free string rather than a union — a new column must not make the mirror
 *  reject rows it does not recognise. */
export type Status = string | null;

/** One leaf's position in the transparency log, Rekor-shaped.
 *
 *  `inclusion_proof` is the audit path from this leaf to the head's
 *  `root_hash`; a consumer holding the leaf, the path and a signed head can
 *  verify membership with no other network call. Opaque to the mirror — see
 *  `BoardItem.provenance`. */
export type LogLeaf = {
  leaf_index: number;
  leaf_hash: string;
  inclusion_proof?: string[];
};

/** The log's signed checkpoint — "the feed is at head X".
 *
 *  This is the whole verification story in one object, and the reason the feed
 *  itself needs no signature: it asserts a position, and every row proves
 *  membership against it. `tree_size` advancing is also a liveness signal that
 *  cannot be faked by re-serving — unlike `generated_at`, which any responder
 *  can refresh (#276). A consumer that kept an earlier head can additionally
 *  demand a consistency proof and detect a rewrite. */
export type LogHead = {
  tree_size: number;
  root_hash: string;
  /** RFC 3339, second precision — same rule as every other stamp here. */
  signed_at: string;
  /** Detached signature over (tree_size, root_hash, signed_at). Absent until
   *  the signer is wired; absent MUST read as unverified, never as trusted. */
  signature?: string;
};

/** One item on the board, mirroring the field names front-desk-projection.sh
 *  already emits.
 *
 *  The shape is copied rather than improved ON PURPOSE: `front-desk.sh`, the
 *  coverage lane and the public filter all read these exact keys today, so a
 *  desk that serves the same shape is a drop-in for the branch snapshot and the
 *  migration needs no consumer changes. Improve it after the cutover, not
 *  during it. */
export type BoardItem = {
  /** `projects_v2_item` node id — the identity, stable across edits. */
  item_id: string;
  type: string; // "Issue" | "PullRequest" | "DraftIssue"
  /** "owner/name", or null for a DraftIssue that has no repo at all. */
  repo: string | null;
  /** Tri-state ON PURPOSE. `null` means visibility was not established, which
   *  the public filter treats as "not permitted" rather than "not private". */
  repo_private: boolean | null;
  number: number | null;
  title: string;
  url: string | null;
  issue_state: string | null; // "OPEN" | "CLOSED"
  assignees: string[];
  labels: string[];
  claimed: boolean;
  fields: Record<string, string | number | null>;
  /** Ordering key. RFC 3339. See "Difference 1" above for why this is weaker
   *  than ci-state's runId and why reconcile is the answer rather than a
   *  cleverer comparison here. */
  updated_at: string;
  /** This item's position in the transparency log — a Rekor-shaped leaf.
   *
   *  PER ITEM, NOT PER FEED, and the filter is why: `toPublicSnapshot` drops
   *  every private row, so a signature over the whole published snapshot would
   *  be invalidated by the act of publishing it. A signature that cannot
   *  survive filtering is one that gets stripped, and an unverifiable feed is
   *  what we already have.
   *
   *  A bare per-item signature is not enough either — it proves a row is
   *  authentic while saying nothing about whether the feed is COMPLETE or
   *  whether history was quietly rewritten. Rekor's answer is a signed tree
   *  head plus per-leaf inclusion proofs, which buys three properties off one
   *  structure: the row is authentic, it is provably IN the log, and the log is
   *  provably append-only against any earlier head a consumer has kept.
   *
   *  So the feed does not have to ship verified content — it only has to say
   *  where it is (`Snapshot.head`) and let each row prove membership. A
   *  consumer verifies ONE row without fetching or trusting the rest, which is
   *  exactly what filtering demands.
   *
   *  Carried opaquely: computing leaf hashes, proofs and signatures belongs to
   *  the log and the signer (ocap-provenance / keeperd), not to the mirror.
   *  This field only has to survive the fold and the filter — which is what the
   *  tests pin, and all that is in scope for the first increment. */
  provenance?: LogLeaf;
};

export type BoardState = {
  /** Keyed by `item_id`. One entry per board item, holding its newest seen form. */
  items: Record<string, BoardItem>;
};

export const emptyBoard = (): BoardState => ({ items: {} });

/** Canonical form of an item: JSON with keys sorted at every level.
 *
 *  Exists only as a deterministic TIEBREAKER (see `applyItem`). Key order must
 *  not affect the result, or two structurally-identical items built by
 *  different code paths — a webhook adapter and a reconcile parser, say — would
 *  compare unequal and the fold would stop converging. */
function canon(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canon(obj[k])}`)
    .join(",");
  return `{${body}}`;
}

/** Fold one item in, newest-`updated_at`-wins, ties broken deterministically.
 *
 *  A stamp that does not parse is REJECTED rather than accepted-as-newest: an
 *  unparseable ordering key cannot be compared, and admitting it would let one
 *  malformed delivery overwrite good state permanently. Reconcile repairs the
 *  omission; nothing repairs a bad overwrite.
 *
 *  ── Why ties get a tiebreaker rather than "keep the incumbent" ─────────────
 *  `updated_at` is second-precision and not unique, so ties are REAL here in a
 *  way they never are for ci-state (whose `runId` is unique per run). An
 *  earlier draft kept the incumbent on a tie; a property test found the
 *  counterexample in seconds — fold a tied pair forward and you keep the first,
 *  fold it backward and you keep the other, so the fold was ORDER-DEPENDENT.
 *
 *  That is not a cosmetic defect. Order-insensitivity is what makes this a
 *  join, and being a join is what makes the mirror CONVERGE under out-of-order
 *  webhook delivery — the property #704 commits to proving. A reducer that is
 *  not a join cannot be proved convergent, because it isn't.
 *
 *  So ties resolve by canonical form: total, deterministic, and independent of
 *  arrival order. Which of two same-second edits "really" came last is
 *  unknowable from the data; picking consistently is what matters, and
 *  reconcile remains the authority that repairs any genuinely wrong pick. */
export function applyItem(state: BoardState, item: BoardItem): BoardState {
  const at = Date.parse(item.updated_at ?? "");
  if (Number.isNaN(at)) return state;

  const prev = state.items[item.item_id];
  if (prev) {
    const prevAt = Date.parse(prev.updated_at ?? "");
    if (!Number.isNaN(prevAt)) {
      if (prevAt > at) return state;
      if (prevAt === at && canon(prev) >= canon(item)) return state;
    }
  }
  return { items: { ...state.items, [item.item_id]: item } };
}

export function applyAll(state: BoardState, items: readonly BoardItem[]): BoardState {
  return items.reduce(applyItem, state);
}

/** Remove an item — a `projects_v2_item.deleted` delivery, or a reconcile that
 *  finds it gone. Unconditional: a delete carries no `updated_at` to compare
 *  and a card that left the board must not linger as claimable work. */
export function removeItem(state: BoardState, itemId: string): BoardState {
  if (!(itemId in state.items)) return state;
  const items = { ...state.items };
  delete items[itemId];
  return { items };
}

/** Reconcile: a full board read REPLACES state.
 *
 *  Not a fold — the point is to erase drift, and folding cannot remove an item
 *  the webhook stream told us about but the board no longer has. This is the
 *  authority that makes the weaker `updated_at` ordering safe. */
export function replaceAll(items: readonly BoardItem[]): BoardState {
  const next: Record<string, BoardItem> = {};
  for (const item of items) next[item.item_id] = item;
  return { items: next };
}

export type Snapshot = {
  generated_at: string;
  /** When the newest webhook delivery landed, and when reconcile last ran.
   *
   *  TWO clocks, and neither is `generated_at`. Serving refreshes only
   *  `generated_at`; a mirror that has gone deaf keeps serving while these two
   *  stop advancing, which is the ONLY way a consumer can tell "the board is
   *  quiet" from "we stopped hearing about it". #276 is the incident where a
   *  snapshot skipping the write went on looking authoritative while its stamp
   *  rotted — same failure, so the same rule: these come from state, never from
   *  the act of responding. */
  last_event_at: string | null;
  last_reconciled_at: string | null;
  /** Where the feed is, in the sense a transparency log means it. `null` until
   *  the log is wired, and null MUST read as unverified rather than as fine —
   *  the same rule as a missing signature. */
  head: LogHead | null;
  item_count: number;
  counts: Record<string, number>;
  items: BoardItem[];
};

export type SnapshotInput = {
  now: Date;
  lastEventAt?: string | null;
  lastReconciledAt?: string | null;
  head?: LogHead | null;
};

const statusOf = (item: BoardItem): string => {
  const s = item.fields?.Status;
  return typeof s === "string" && s.length > 0 ? s : "(no status)";
};

/** Render state as the board body. Item order is stable (by `item_id`) so two
 *  renders of identical state are byte-identical — a diffing consumer, and any
 *  future signature over the rendered form, both need that. */
export function toSnapshot(state: BoardState, input: SnapshotInput): Snapshot {
  const items = Object.values(state.items).sort((a, b) => a.item_id.localeCompare(b.item_id));

  const counts: Record<string, number> = {};
  for (const item of items) {
    const s = statusOf(item);
    counts[s] = (counts[s] ?? 0) + 1;
  }

  return {
    generated_at: stampRfc3339(input.now),
    last_event_at: input.lastEventAt ?? null,
    last_reconciled_at: input.lastReconciledAt ?? null,
    head: input.head ?? null,
    item_count: items.length,
    counts,
    items,
  };
}

/** Fields a public row may carry. ALLOWLIST, not a denylist.
 *
 *  A field added upstream — a new board column, an internal note — cannot ride
 *  into the public feed just because nobody thought about it here. Adding a key
 *  is a deliberate edit with a test to match.
 *
 *  `assignees` is deliberately absent: `claimed` already answers the only
 *  question a public reader needs ("is someone on this?") without republishing
 *  a roster. `repo_private` is absent because it is the filter's input, not its
 *  output — carrying it would invite a consumer to re-derive the check we have
 *  already made. `provenance` IS carried: a public row nobody can verify is the
 *  thing this feed exists to stop being. */
const PUBLIC_FIELDS = [
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
] as const;

export type PublicItem = Pick<BoardItem, (typeof PUBLIC_FIELDS)[number]>;

export type PublicSnapshot = Omit<Snapshot, "items"> & { items: PublicItem[] };

/** The publishable projection: default-deny in rows AND fields (#651).
 *
 *  A row survives only when the mirror POSITIVELY established that its repo is
 *  public — `repo_private` exactly `false`. Every other case drops:
 *
 *    repo_private: true   → private repo, obviously out
 *    repo_private: null   → visibility UNKNOWN. Unknown is not permission. A
 *                           denylist would publish these; an allowlist refuses
 *                           them, and refusing is the only direction whose
 *                           failure mode is "too little published" rather than
 *                           "a private title on the internet".
 *    repo: null           → a DraftIssue with nothing to attribute the row to.
 *
 *  Same fail-direction rule claim-boundary.md applies to the claim door: when
 *  the product of a step is a sentence someone will believe, a false green is
 *  the expensive failure, so the step fails closed. */
export function toPublicSnapshot(snapshot: Snapshot): PublicSnapshot {
  const items = snapshot.items
    .filter((item) => item.repo !== null && item.repo_private === false)
    .map((item) => {
      const out = {} as Record<string, unknown>;
      for (const key of PUBLIC_FIELDS) {
        if (key in item && item[key] !== undefined) out[key] = item[key];
      }
      return out as PublicItem;
    });

  const counts: Record<string, number> = {};
  for (const item of items) {
    const s = typeof item.fields?.Status === "string" ? item.fields.Status : "(no status)";
    counts[s] = (counts[s] ?? 0) + 1;
  }

  return { ...snapshot, item_count: items.length, counts, items };
}
