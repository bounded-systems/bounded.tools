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
// WHAT IT IS NOT. It does not upload anywhere. v1 RETURNS the Graph to the
// caller; forwarding to the pathbase door stays a follow-up because a mobile
// chat has no claim issue for the door's stamp, and the door's forced
// `visibility` must not be bypassed by a second uploader beside it (#50 lists
// both as out of scope). It also holds no vendor credential: the snapshot
// endpoint answers for public shares only, so the relay can never reach a chat
// its caller could not already read in a browser.
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
   *  Worker secret — never in git. Absent or empty ⇒ the relay refuses all. */
  CLAUDE_RELAY_LEASES?: string;
};

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

// ── the handler ──────────────────────────────────────────────────────────────

export type RelayDeps = {
  fetchImpl?: typeof fetch;
};

const SNAPSHOT_HOST = "https://api.claude.ai";

export async function handleClaudeRelay(
  request: Request,
  env: RelayEnv,
  deps: RelayDeps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const leases = parseLeases(env.CLAUDE_RELAY_LEASES);
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
  try {
    const body = (await request.json()) as Record<string, unknown>;
    uuid = parseShareUrl(body?.share_url);
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
  // so the caller can tell a dead endpoint from a withdrawn share.
  if (upstream.status === 404 || upstream.status === 403) {
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

  console.log(`[claude-relay] lease=${lease} chat=${uuid} steps=${converted.steps}`);
  return new Response(JSON.stringify(converted.graph), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
