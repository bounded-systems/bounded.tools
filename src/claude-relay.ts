// /claude/sessions — the Claude chat-session relay (#50).
//
// WHY THIS EXISTS. The org's provenance loop (toolpath → pathbase) covers
// Claude Code sessions only: `path` reads `~/.claude/projects/`, and a Claude
// mobile/web chat never touches a filesystem any org tooling can see. The one
// credential-free way such a chat leaves claude.ai is its share link —
// `https://claude.ai/share/<uuid>`, backed by an unauthenticated snapshot
// endpoint — and a session cannot fetch even that (`api.claude.ai` is not on
// the session egress allowlist), while a phone cannot run a converter. This
// Worker has unrestricted egress, so the relay lives here: one POST turns a
// share link into a toolpath Graph document the rest of the org's machinery
// already understands.
//
// WHAT IT IS NOT. It is a converter, never an authority. Without a `claim` in
// the body it RETURNS the Graph to the caller; with one it forwards the Graph
// through the PATHBASE DOOR's claim tier (#59, closing the leg #50 deferred) —
// and the door keeps every power it had: it verifies the claim live, forces
// the `<repo>#<issue> <claimant>` stamp and `visibility: private`, enforces
// its per-claim ceilings, and posts its own testimony. The relay holds no
// vendor credential either way: the snapshot endpoint answers for public
// shares only (the relay can never reach a chat its caller could not already
// read in a browser), and the PATHBASE_PAT stays vaulted behind the door.
//
// THE THREE GATES, in order, each fail-closed (the github-door shape, #36):
//   1. LEASE  — `Authorization: Bearer <token>` must match a named lease in
//               CLAUDE_RELAY_LEASES (Worker secret, `name:token` per line —
//               same format as DOOR_LEASES, DELIBERATELY a separate secret so
//               revoking one door never touches the other). No leases ⇒ 503
//               for everything: an unconfigured relay serves nobody, never
//               everybody.
//   2. POLICY — POST only, and the body's `share_url` must be exactly a
//               claude.ai share link. The upstream host and path are pinned
//               here; a caller names a UUID, never a URL to fetch.
//   3. SHAPE  — the snapshot must convert. A payload that does not carry a
//               non-empty `chat_messages` array refuses with the reason named,
//               rather than relaying bytes this module did not understand.

import { authenticate, parseLeases } from "./github-door";

export type RelayEnv = {
  /** Named bearer leases, one `name:token` per line (or comma-separated).
   *  Worker secret — never in git. The STANDING line: long-lived holders
   *  (a phone Shortcut), rotated deliberately. */
  CLAUDE_RELAY_LEASES?: string;
  /** Grant slots (#62): per-session bearers written round-robin by the deploy
   *  lane's grant input. Slots exist because Worker Secrets are write-only —
   *  "append a line" is impossible, so multi-holder means a bounded ring, and
   *  a new grant displaces only the OLDEST grant, never the standing line.
   *  All three merge into one lease table; all absent ⇒ refuse all. */
  CLAUDE_RELAY_LEASES_A?: string;
  CLAUDE_RELAY_LEASES_B?: string;
};

/** The merged lease table. Newline-joined so a slot value can never splice
 *  into another's trailing line, whatever it ends with. */
export function mergedLeases(env: RelayEnv): string {
  return [env.CLAUDE_RELAY_LEASES, env.CLAUDE_RELAY_LEASES_A, env.CLAUDE_RELAY_LEASES_B]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join("\n");
}

export const SHARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Extract the snapshot UUID from a claude.ai share link. Host and shape are
 *  pinned: this is the only URL family the relay will ever dereference, so a
 *  caller cannot aim the Worker's egress anywhere else. A bare UUID is
 *  accepted too — the URL is a carrier for it, nothing more. */
export function parseShareUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (SHARE_UUID.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "claude.ai") return null;
  const m = url.pathname.match(/^\/share\/([0-9a-f-]{36})\/?$/);
  if (!m || !SHARE_UUID.test(m[1]!)) return null;
  return m[1]!;
}

// ── snapshot → toolpath Graph ────────────────────────────────────────────────
//
// The target shape is what `path p derive claude` emits (verified against the
// 0.16.1 binary, 2026-08-31): a `graph` header, one `paths` entry whose `path`
// carries `id`/`base`/`head`, and linear `steps` whose `change` maps a source
// URI to a `structural` entry. Chat turns become `conversation.append` steps;
// the snapshot's own metadata rides one leading `conversation.event` step. The
// original message object travels in `raw` on every step — the converter
// normalizes what it understands and DROPS NOTHING, so a vendor field this
// module has never heard of still reaches the archive.

type Structural = Record<string, unknown>;

export type GraphStep = {
  step: { id: string; parents?: string[]; actor: string; timestamp: string };
  change: Record<string, { structural: Structural }>;
};

export type GraphDocument = {
  graph: { id: string };
  paths: Array<{
    path: { id: string; base: { uri: string; branch: string }; head: string };
    steps: GraphStep[];
  }>;
};

export type ConvertResult =
  | { ok: true; graph: GraphDocument; steps: number }
  | { ok: false; reason: string };

const EPOCH = "1970-01-01T00:00:00.000Z";

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Join the text of content blocks matching `type`, tolerating both the
 *  block's own field name (`text`, `thinking`) and plain `text`. */
function joinBlocks(content: unknown, type: string): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== type) continue;
    const value = b[type] ?? b.text;
    if (typeof value === "string" && value.length > 0) parts.push(value);
  }
  return parts.join("\n\n");
}

/** `agent:<model>` with the model sanitized to the actor charset the deriver
 *  uses; anything unusable collapses to the honest generic. */
function assistantActor(model: unknown): string {
  return typeof model === "string" && /^[A-Za-z0-9._-]+$/.test(model)
    ? `agent:${model}`
    : "agent:claude";
}

export function snapshotToGraph(snapshot: unknown, uuid: string): ConvertResult {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { ok: false, reason: "snapshot is not a JSON object" };
  }
  const top = snapshot as Record<string, unknown>;
  const messages = top.chat_messages;
  if (!Array.isArray(messages)) {
    return { ok: false, reason: "snapshot has no chat_messages array" };
  }
  if (messages.length === 0) {
    return { ok: false, reason: "snapshot has an empty chat_messages array" };
  }

  const source = `claude-chat://${uuid}`;
  const id = `path-claude-chat-${uuid.slice(0, 8)}`;
  const snapshotTime = isoOrNull(top.created_at);

  // Leading metadata step: the chat's own header (title, summary, model) has
  // no turn to live on, and the deriver's convention for non-turn context is a
  // `conversation.event` carrying `raw`.
  const meta: GraphStep = {
    step: {
      id: "chat-meta",
      actor: "tool:claude-chat-relay",
      timestamp: snapshotTime ?? EPOCH,
    },
    change: {
      [source]: {
        structural: {
          type: "conversation.event",
          raw: {
            uuid: top.uuid ?? uuid,
            name: top.name,
            summary: top.summary,
            model: top.model,
            created_at: top.created_at,
            updated_at: top.updated_at,
          },
        },
      },
    },
  };

  const steps: GraphStep[] = [meta];
  const seen = new Set<string>(["chat-meta"]);
  let lastTimestamp = meta.step.timestamp;

  messages.forEach((entry, index) => {
    const msg = entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)
      : {};
    const human = msg.sender === "human";
    const rawId = typeof msg.uuid === "string" ? msg.uuid : "";
    const stepId = SHARE_UUID.test(rawId) && !seen.has(rawId) ? rawId : `msg-${index}`;
    seen.add(stepId);
    const timestamp = isoOrNull(msg.created_at) ?? lastTimestamp;
    lastTimestamp = timestamp;

    const structural: Structural = {
      type: "conversation.append",
      role: human ? "user" : "assistant",
      text: joinBlocks(msg.content, "text") || (typeof msg.text === "string" ? msg.text : ""),
      raw: entry,
    };
    const thinking = joinBlocks(msg.content, "thinking");
    if (thinking) structural.thinking = thinking;

    const prev = steps[steps.length - 1]!;
    steps.push({
      step: {
        id: stepId,
        parents: [prev.step.id],
        actor: human ? "human:user" : assistantActor(msg.model ?? top.model),
        timestamp,
      },
      change: { [source]: { structural } },
    });
  });

  return {
    ok: true,
    steps: steps.length,
    graph: {
      graph: { id },
      paths: [
        {
          path: {
            id,
            base: { uri: `https://claude.ai/share/${uuid}`, branch: "HEAD" },
            head: steps[steps.length - 1]!.step.id,
          },
          steps,
        },
      ],
    },
  };
}

// ── the door forward ─────────────────────────────────────────────────────────
//
// The same grammar the door's own parseDoorPath enforces (infra
// cloudflare/pathbase-door): a plain repository name and a 1–10 digit issue.
// Validated HERE too so a malformed claim is the caller's 400, not a
// door-shaped 404 the caller has to decode.

const CLAIM_REPO = /^[A-Za-z0-9._-]+$/;
const CLAIM_ISSUE = /^[0-9]{1,10}$/;

export type DoorClaim = { repo: string; issue: string };

export function parseClaim(input: unknown): DoorClaim | null | "malformed" {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) return "malformed";
  const c = input as Record<string, unknown>;
  const repo = typeof c.repo === "string" ? c.repo.trim() : "";
  const issue = typeof c.issue === "number" && Number.isInteger(c.issue) && c.issue > 0
    ? String(c.issue)
    : typeof c.issue === "string"
      ? c.issue.trim()
      : "";
  if (!CLAIM_REPO.test(repo) || !CLAIM_ISSUE.test(issue)) return "malformed";
  return { repo, issue };
}

// ── the handler ──────────────────────────────────────────────────────────────

export type RelayDeps = {
  fetchImpl?: typeof fetch;
};

// claude.ai serves its API same-origin — `api.claude.ai` is NXDOMAIN, measured
// 2026-08-31 (#56): the Worker's fetch of it answered Cloudflare's 530
// origin-DNS error, and a second client confirmed ENOTFOUND. The host stays
// pinned here for the same reason it always was: a caller names a UUID, never
// a URL to fetch.
const SNAPSHOT_HOST = "https://claude.ai";

// The pathbase door's public custom domain (infra cloudflare/pathbase-door) —
// a literal for the same reason SNAPSHOT_HOST is: a caller names a claim,
// never a URL to forward to.
const DOOR_HOST = "https://pathbase.bounded.tools";

export async function handleClaudeRelay(
  request: Request,
  env: RelayEnv,
  deps: RelayDeps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const leases = parseLeases(mergedLeases(env));
  if (leases.size === 0) {
    // Unconfigured ⇒ closed for everyone — and distinguishable from a bad
    // lease, so "the relay is down" and "your lease is wrong" never blur.
    return new Response("relay has no leases configured — refusing all requests", {
      status: 503,
    });
  }

  const lease = await authenticate(request.headers.get("authorization"), leases);
  if (!lease) return new Response("missing or unknown relay lease", { status: 401 });

  if (request.method !== "POST") {
    return new Response("relay takes POST only", { status: 405 });
  }

  let uuid: string | null = null;
  let claim: DoorClaim | null | "malformed" = null;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    uuid = parseShareUrl(body?.share_url);
    claim = parseClaim(body?.claim);
  } catch {
    // fall through to the 400 below — malformed JSON and a bad URL are the
    // same caller error.
  }
  if (!uuid) {
    return new Response(
      'body must be JSON {"share_url": "https://claude.ai/share/<uuid>"}',
      { status: 400 },
    );
  }
  if (claim === "malformed") {
    return new Response(
      '"claim", when present, must be {"repo": "<plain repo name>", "issue": <number>}',
      { status: 400 },
    );
  }

  const upstream = await fetchImpl(
    `${SNAPSHOT_HOST}/api/chat_snapshots/${uuid}?rendering_mode=messages`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "bounded-tools-claude-relay",
      },
    },
  );
  // The vendor answers 404 for both "never existed" and "not shared"; anything
  // else non-200 is the vendor's problem, relayed as 502 with the status named
  // so the caller can tell a dead endpoint from a withdrawn share. 403 is
  // DELIBERATELY not folded into 404 (#56): on this host a 403 can be the
  // vendor's bot filtering refusing the Worker, and reading that as "not
  // shared" would send the caller to re-share a chat that was never the
  // problem. Named status beats a guessed meaning.
  if (upstream.status === 404) {
    return new Response("snapshot not found — the chat is not (or no longer) shared", {
      status: 404,
    });
  }
  if (!upstream.ok) {
    return new Response(`snapshot fetch failed upstream: HTTP ${upstream.status}`, {
      status: 502,
    });
  }

  let snapshot: unknown;
  try {
    snapshot = await upstream.json();
  } catch {
    return new Response("snapshot fetch returned non-JSON", { status: 502 });
  }

  const converted = snapshotToGraph(snapshot, uuid);
  if (!converted.ok) {
    return new Response(`snapshot did not convert: ${converted.reason}`, { status: 422 });
  }

  if (!claim) {
    console.log(`[claude-relay] lease=${lease} chat=${uuid} steps=${converted.steps}`);
    return new Response(JSON.stringify(converted.graph), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  // The door keeps all of its own powers — live-claim gate, forced stamp and
  // visibility, ceilings, testimony post-back — so its answer goes to the
  // caller VERBATIM: a door refusal (unclaimed issue, rate ceiling, oversize)
  // is caller-actionable and must not be blurred into a relay 502. Only the
  // two door headers are relayed; everything else stays behind.
  const doorResp = await fetchImpl(
    `${DOOR_HOST}/c/${claim.repo}/${claim.issue}/api/v1/u/anon/repos/pathstash/graphs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document: converted.graph }),
    },
  );
  const doorBody = await doorResp.text();
  const headers = new Headers({ "cache-control": "no-store" });
  for (const name of ["content-type", "x-door-claim", "x-door-postback"]) {
    const value = doorResp.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  console.log(
    `[claude-relay] lease=${lease} chat=${uuid} steps=${converted.steps} door=${claim.repo}#${claim.issue} -> ${doorResp.status}`,
  );
  return new Response(doorBody, { status: doorResp.status, headers });
}
