// The load-bearing cases are the refusals: an unconfigured door must serve
// NOBODY (503, distinct from a bad lease's 401), the owner pin must hold
// against caller-named owners and traversal, and the 401-remint retry must
// fire exactly once — a second 401 is real and reaches the caller.

import { beforeEach, describe, expect, test } from "bun:test";

import {
  authenticate,
  checkPath,
  handleGithubDoor,
  parseLeases,
  resetTokenCacheForTests,
  type DoorEnv,
} from "./github-door";

const LEASE = "sweep-session-0123456789abcdef";

describe("parseLeases", () => {
  test("parses name:token per line and per comma", () => {
    const m = parseLeases(`alpha:${LEASE}\nbeta:${LEASE}x, gamma:${LEASE}y`);
    expect([...m.keys()]).toEqual(["alpha", "beta", "gamma"]);
  });

  test("skips malformed and short entries", () => {
    const m = parseLeases(`:${LEASE}\nno-separator\nshort:abc\nok:${LEASE}`);
    expect([...m.keys()]).toEqual(["ok"]);
  });

  test("absent secret is an empty lease set", () => {
    expect(parseLeases(undefined).size).toBe(0);
  });
});

describe("authenticate", () => {
  const leases = parseLeases(`alpha:${LEASE}`);

  test("resolves a valid bearer to its lease name", async () => {
    expect(await authenticate(`Bearer ${LEASE}`, leases)).toBe("alpha");
  });

  test("wrong token, wrong scheme, and absent header all refuse", async () => {
    expect(await authenticate(`Bearer ${LEASE}WRONG`, leases)).toBeNull();
    expect(await authenticate(`Basic ${LEASE}`, leases)).toBeNull();
    expect(await authenticate(null, leases)).toBeNull();
  });
});

describe("checkPath", () => {
  test("allows the org repo list, repo subpaths, and rate_limit", () => {
    for (const p of [
      "/gh/orgs/bounded-systems/repos",
      "/gh/repos/bounded-systems/prx/pulls",
      "/gh/repos/bounded-systems/.github-private/issues/480",
      "/gh/rate_limit",
    ]) {
      expect(checkPath("GET", p).ok).toBe(true);
    }
  });

  test("the owner is pinned — other owners refuse", () => {
    expect(checkPath("GET", "/gh/repos/somebody-else/prx/pulls").ok).toBe(false);
    expect(checkPath("GET", "/gh/orgs/somebody-else/repos").ok).toBe(false);
  });

  test("non-read methods refuse with 405", () => {
    const r = checkPath("PUT", "/gh/repos/bounded-systems/prx/pulls/1/merge");
    expect(r).toMatchObject({ ok: false, status: 405 });
  });

  test("traversal and unknown roots refuse", () => {
    expect(checkPath("GET", "/gh/repos/bounded-systems/prx/../../user").ok).toBe(false);
    expect(checkPath("GET", "/gh/user").ok).toBe(false);
    expect(checkPath("GET", "/gh/repos/bounded-systems/").ok).toBe(false);
  });
});

// ── the handler, broker and upstream both faked ──────────────────────────────

type Call = { url: string; init?: RequestInit };

function makeEnv(overrides: Partial<DoorEnv> = {}): { env: DoorEnv; mints: Call[] } {
  const mints: Call[] = [];
  const env: DoorEnv = {
    DOOR_LEASES: `alpha:${LEASE}`,
    BROKER: {
      fetch: (async (url: string, init?: RequestInit) => {
        mints.push({ url: String(url), init });
        return new Response(JSON.stringify({ token: `tok-${mints.length}` }), { status: 200 });
      }) as unknown as Fetcher["fetch"],
    } as Fetcher,
    ...overrides,
  };
  return { env, mints };
}

const req = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://github.bounded.tools${path}`, {
    headers: { authorization: `Bearer ${LEASE}`, ...headers },
  });

beforeEach(() => resetTokenCacheForTests());

describe("handleGithubDoor", () => {
  test("no leases configured refuses everything with 503", async () => {
    const { env } = makeEnv({ DOOR_LEASES: "" });
    const res = await handleGithubDoor(req("/gh/rate_limit"), env);
    expect(res.status).toBe(503);
  });

  test("unknown lease is 401, before any mint or upstream call", async () => {
    const { env, mints } = makeEnv();
    const upstream: Call[] = [];
    const res = await handleGithubDoor(
      req("/gh/rate_limit", { authorization: "Bearer nope-nope-nope-nope-nope" }),
      env,
      { fetchImpl: (async (u: string) => (upstream.push({ url: u }), new Response("x"))) as unknown as typeof fetch },
    );
    expect(res.status).toBe(401);
    expect(mints.length).toBe(0);
    expect(upstream.length).toBe(0);
  });

  test("disallowed path is 403 without an upstream call", async () => {
    const { env } = makeEnv();
    const upstream: Call[] = [];
    const res = await handleGithubDoor(req("/gh/user"), env, {
      fetchImpl: (async (u: string) => (upstream.push({ url: u }), new Response("x"))) as unknown as typeof fetch,
    });
    expect(res.status).toBe(403);
    expect(upstream.length).toBe(0);
  });

  test("forwards with the minted token and relays the allowlisted headers", async () => {
    const { env, mints } = makeEnv();
    const upstream: Call[] = [];
    const res = await handleGithubDoor(
      req("/gh/repos/bounded-systems/prx/pulls?state=open&per_page=5"),
      env,
      {
        fetchImpl: (async (u: string, init?: RequestInit) => {
          upstream.push({ url: u, init });
          return new Response(JSON.stringify([{ number: 1 }]), {
            status: 200,
            headers: {
              "content-type": "application/json",
              link: '<next>; rel="next"',
              "set-cookie": "leak=1",
              "x-ratelimit-remaining": "4999",
            },
          });
        }) as unknown as typeof fetch,
      },
    );
    expect(res.status).toBe(200);
    expect(upstream[0]?.url).toBe(
      "https://api.github.com/repos/bounded-systems/prx/pulls?state=open&per_page=5",
    );
    const sent = new Headers(upstream[0]?.init?.headers as unknown as Record<string, string>);
    expect(sent.get("authorization")).toBe("Bearer tok-1");
    expect(sent.get("x-github-api-version")).toBe("2022-11-28");
    expect(mints.length).toBe(1);
    expect(res.headers.get("link")).toBe('<next>; rel="next"');
    expect(res.headers.get("x-ratelimit-remaining")).toBe("4999");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("the token is cached across requests", async () => {
    const { env, mints } = makeEnv();
    const ok = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await handleGithubDoor(req("/gh/rate_limit"), env, { fetchImpl: ok });
    await handleGithubDoor(req("/gh/rate_limit"), env, { fetchImpl: ok });
    expect(mints.length).toBe(1);
  });

  test("a 401 upstream drops the cache and remints exactly once", async () => {
    const { env, mints } = makeEnv();
    const statuses = [401, 200];
    const seen: string[] = [];
    const res = await handleGithubDoor(req("/gh/rate_limit"), env, {
      fetchImpl: (async (_u: string, init?: RequestInit) => {
        seen.push(new Headers(init?.headers as unknown as Record<string, string>).get("authorization") ?? "");
        return new Response("{}", { status: statuses.shift() ?? 200 });
      }) as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    expect(mints.length).toBe(2);
    expect(seen).toEqual(["Bearer tok-1", "Bearer tok-2"]);
  });

  test("a second 401 is real and reaches the caller", async () => {
    const { env, mints } = makeEnv();
    const res = await handleGithubDoor(req("/gh/rate_limit"), env, {
      fetchImpl: (async () => new Response("bad credentials", { status: 401 })) as unknown as typeof fetch,
    });
    expect(res.status).toBe(401);
    expect(mints.length).toBe(2);
  });

  test("a failed mint is 502, not a pass-through", async () => {
    const { env } = makeEnv();
    (env.BROKER as { fetch: unknown }).fetch = (async () =>
      new Response("nope", { status: 403 })) as unknown as Fetcher["fetch"];
    const res = await handleGithubDoor(req("/gh/rate_limit"), env);
    expect(res.status).toBe(502);
  });
});
