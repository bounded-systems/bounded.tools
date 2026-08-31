// The load-bearing cases are the refusals, same as the github door: an
// unconfigured relay serves NOBODY (503, distinct from a bad lease's 401), the
// upstream host is pinned (a caller names a UUID, never a URL to fetch), and a
// snapshot the converter does not understand refuses with the reason named
// rather than relaying bytes. The converter itself must drop nothing: every
// message rides through in `raw`, whatever fields it carries.

import { describe, expect, test } from "bun:test";

import {
  handleClaudeRelay,
  parseShareUrl,
  snapshotToGraph,
  type RelayEnv,
} from "./claude-relay";

const UUID = "2d5c237b-1428-4022-9a75-b4346fcaf006";
const LEASE = "relay-session-0123456789abcdef";

describe("parseShareUrl", () => {
  test("accepts the share link, with and without trailing slash, and a bare uuid", () => {
    expect(parseShareUrl(`https://claude.ai/share/${UUID}`)).toBe(UUID);
    expect(parseShareUrl(`https://claude.ai/share/${UUID}/`)).toBe(UUID);
    expect(parseShareUrl(UUID)).toBe(UUID);
    expect(parseShareUrl(`  https://claude.ai/share/${UUID}  `)).toBe(UUID);
  });

  test("the host is pinned — other hosts, schemes, and paths refuse", () => {
    expect(parseShareUrl(`https://evil.example/share/${UUID}`)).toBeNull();
    expect(parseShareUrl(`http://claude.ai/share/${UUID}`)).toBeNull();
    expect(parseShareUrl(`https://claude.ai/chat/${UUID}`)).toBeNull();
    expect(parseShareUrl(`https://claude.ai/share/${UUID}/extra`)).toBeNull();
    expect(parseShareUrl(`https://api.claude.ai/share/${UUID}`)).toBeNull();
  });

  test("malformed uuids and non-strings refuse", () => {
    expect(parseShareUrl("https://claude.ai/share/not-a-uuid")).toBeNull();
    expect(parseShareUrl(`https://claude.ai/share/${UUID.slice(0, -1)}`)).toBeNull();
    expect(parseShareUrl(42)).toBeNull();
    expect(parseShareUrl(undefined)).toBeNull();
  });
});

// ── the converter ────────────────────────────────────────────────────────────

const MSG_A = "aaaaaaaa-1111-4222-8333-444444444444";
const MSG_B = "bbbbbbbb-1111-4222-8333-444444444444";

const snapshot = {
  uuid: UUID,
  name: "Reading mobile sessions",
  summary: "",
  model: "claude-fable-5",
  created_at: "2026-08-31T12:00:00Z",
  updated_at: "2026-08-31T12:30:00Z",
  chat_messages: [
    {
      uuid: MSG_A,
      sender: "human",
      created_at: "2026-08-31T12:00:01Z",
      content: [{ type: "text", text: "hello" }],
      attachments: [{ file_name: "notes.txt" }],
    },
    {
      uuid: MSG_B,
      sender: "assistant",
      created_at: "2026-08-31T12:00:05Z",
      content: [
        { type: "thinking", thinking: "pondering" },
        { type: "text", text: "hi" },
        { type: "text", text: "there" },
      ],
    },
  ],
};

describe("snapshotToGraph", () => {
  test("builds one linear path: meta step first, head is the last message", () => {
    const r = snapshotToGraph(snapshot, UUID);
    if (!r.ok) throw new Error(r.reason);
    const doc = r.graph;
    expect(doc.graph.id).toBe("path-claude-chat-2d5c237b");
    const path = doc.paths[0]!;
    expect(path.path.base.uri).toBe(`https://claude.ai/share/${UUID}`);
    expect(path.path.head).toBe(MSG_B);
    expect(path.steps.map((s) => s.step.id)).toEqual(["chat-meta", MSG_A, MSG_B]);
    expect(path.steps[1]!.step.parents).toEqual(["chat-meta"]);
    expect(path.steps[2]!.step.parents).toEqual([MSG_A]);
  });

  test("roles, actors, text joining, and thinking come from the messages", () => {
    const r = snapshotToGraph(snapshot, UUID);
    if (!r.ok) throw new Error(r.reason);
    const [meta, human, agent] = r.graph.paths[0]!.steps;
    expect(meta!.step.actor).toBe("tool:claude-chat-relay");
    expect(human!.step.actor).toBe("human:user");
    expect(agent!.step.actor).toBe("agent:claude-fable-5");
    const source = `claude-chat://${UUID}`;
    expect(human!.change[source]!.structural).toMatchObject({
      type: "conversation.append",
      role: "user",
      text: "hello",
    });
    expect(agent!.change[source]!.structural).toMatchObject({
      role: "assistant",
      text: "hi\n\nthere",
      thinking: "pondering",
    });
  });

  test("drops nothing: the original message rides in raw, attachments included", () => {
    const r = snapshotToGraph(snapshot, UUID);
    if (!r.ok) throw new Error(r.reason);
    const source = `claude-chat://${UUID}`;
    const raw = r.graph.paths[0]!.steps[1]!.change[source]!.structural.raw;
    expect(raw).toEqual(snapshot.chat_messages[0]);
  });

  test("tolerates sparse messages: no uuid, no content, no timestamp", () => {
    const r = snapshotToGraph(
      { chat_messages: [{ sender: "human", text: "plain" }, {}] },
      UUID,
    );
    if (!r.ok) throw new Error(r.reason);
    const steps = r.graph.paths[0]!.steps;
    expect(steps.map((s) => s.step.id)).toEqual(["chat-meta", "msg-0", "msg-1"]);
    const source = `claude-chat://${UUID}`;
    expect(steps[1]!.change[source]!.structural.text).toBe("plain");
    // an unknown sender is not silently a human
    expect(steps[2]!.change[source]!.structural.role).toBe("assistant");
  });

  test("duplicate message uuids stay unique step ids", () => {
    const r = snapshotToGraph(
      { chat_messages: [{ uuid: MSG_A, sender: "human" }, { uuid: MSG_A, sender: "assistant" }] },
      UUID,
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.graph.paths[0]!.steps.map((s) => s.step.id)).toEqual(["chat-meta", MSG_A, "msg-1"]);
  });

  test("a snapshot without messages refuses with the reason named", () => {
    expect(snapshotToGraph({}, UUID)).toMatchObject({
      ok: false,
      reason: "snapshot has no chat_messages array",
    });
    expect(snapshotToGraph({ chat_messages: [] }, UUID)).toMatchObject({ ok: false });
    expect(snapshotToGraph(null, UUID)).toMatchObject({ ok: false });
    expect(snapshotToGraph([], UUID)).toMatchObject({ ok: false });
  });
});

// ── the handler, upstream faked ──────────────────────────────────────────────

function env(leases?: string): RelayEnv {
  return { CLAUDE_RELAY_LEASES: leases };
}

function post(body: unknown, token?: string): Request {
  return new Request("https://hooks.bounded.tools/claude/sessions", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}

function upstreamReturning(status: number, body: string) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(body, { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("handleClaudeRelay", () => {
  test("no leases configured ⇒ 503 for everyone, even a would-be-valid caller", async () => {
    const res = await handleClaudeRelay(post({ share_url: UUID }, LEASE), env(undefined));
    expect(res.status).toBe(503);
  });

  test("bad or absent lease ⇒ 401, and the upstream is never touched", async () => {
    const { calls, fetchImpl } = upstreamReturning(200, "{}");
    const res = await handleClaudeRelay(post({ share_url: UUID }, "wrong-token-0123456789abcdef"), env(`ok:${LEASE}`), { fetchImpl });
    expect(res.status).toBe(401);
    const res2 = await handleClaudeRelay(post({ share_url: UUID }), env(`ok:${LEASE}`), { fetchImpl });
    expect(res2.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("non-POST ⇒ 405", async () => {
    const req = new Request("https://hooks.bounded.tools/claude/sessions", {
      headers: { authorization: `Bearer ${LEASE}` },
    });
    const res = await handleClaudeRelay(req, env(`ok:${LEASE}`));
    expect(res.status).toBe(405);
  });

  test("malformed body or non-share url ⇒ 400", async () => {
    for (const body of [{}, { share_url: "https://evil.example/x" }, "not-an-object"]) {
      const res = await handleClaudeRelay(post(body, LEASE), env(`ok:${LEASE}`));
      expect(res.status).toBe(400);
    }
  });

  test("fetches the pinned snapshot endpoint and returns the converted graph", async () => {
    const { calls, fetchImpl } = upstreamReturning(200, JSON.stringify(snapshot));
    const res = await handleClaudeRelay(post({ share_url: `https://claude.ai/share/${UUID}` }, LEASE), env(`ok:${LEASE}`), { fetchImpl });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      `https://claude.ai/api/chat_snapshots/${UUID}?rendering_mode=messages`,
    ]);
    const doc = (await res.json()) as { graph: { id: string } };
    expect(doc.graph.id).toBe("path-claude-chat-2d5c237b");
  });

  test("upstream 404 ⇒ 404; 403 and other failures ⇒ 502 naming the status", async () => {
    const notFound = upstreamReturning(404, "");
    const res404 = await handleClaudeRelay(post({ share_url: UUID }, LEASE), env(`ok:${LEASE}`), { fetchImpl: notFound.fetchImpl });
    expect(res404.status).toBe(404);
    // 403 is NOT "not shared" on this host — it can be the vendor's bot
    // filtering refusing the Worker (#56), so it relays as 502 with the
    // status named rather than sending the caller to re-share a chat.
    for (const status of [403, 500, 530]) {
      const { fetchImpl } = upstreamReturning(status, "");
      const res = await handleClaudeRelay(post({ share_url: UUID }, LEASE), env(`ok:${LEASE}`), { fetchImpl });
      expect(res.status).toBe(502);
      expect(await res.text()).toContain(String(status));
    }
  });

  test("upstream non-JSON ⇒ 502; unconvertible snapshot ⇒ 422 with the reason", async () => {
    const nonJson = upstreamReturning(200, "<!doctype html>");
    const res = await handleClaudeRelay(post({ share_url: UUID }, LEASE), env(`ok:${LEASE}`), { fetchImpl: nonJson.fetchImpl });
    expect(res.status).toBe(502);
    const empty = upstreamReturning(200, JSON.stringify({ chat_messages: [] }));
    const res2 = await handleClaudeRelay(post({ share_url: UUID }, LEASE), env(`ok:${LEASE}`), { fetchImpl: empty.fetchImpl });
    expect(res2.status).toBe(422);
    expect(await res2.text()).toContain("empty chat_messages");
  });
});
