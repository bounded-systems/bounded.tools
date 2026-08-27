// github.bounded.tools — the org's read-only GitHub API door (#36).
//
// WHY THIS EXISTS. The 2026-08-27 org-wide PR sweep (.github-private#480) had
// to attach 60+ repositories to a session one platform call at a time just to
// READ their pull requests: the session-side proxy scopes api.github.com to
// attached repos, and its permission layer intermittently refused the attach
// calls. Reading org state is App-shaped work — one credential, one policy —
// so this door serves it from a host the org owns: a guest makes one HTTPS
// call to github.bounded.tools/gh/... and the Worker executes it against
// api.github.com with a broker-minted installation token. No repo attachment,
// no user credential, every effect attributable to the App.
//
// WHAT IT IS NOT. Read-only, deliberately. GET/HEAD forwarding under an
// allowlist — no merge, no close, no comment, no dispatch. Write verbs are the
// half of #36 gated on a real caller-identity story (keeper-issued leases with
// the passkey ceremony); a bearer lease is enough custody for reads because
// the blast radius is bounded twice over: this module refuses every non-read
// method, AND the broker's registry grant for DOOR_APP carries read scopes
// only — the door cannot exceed what the mint hands it even if this code is
// wrong.
//
// THE THREE GATES, in order, each fail-closed:
//   1. LEASE  — `Authorization: Bearer <token>` must match a named lease in
//               DOOR_LEASES (Worker secret, `name:token` per line). No leases
//               configured ⇒ 503 for everything: an unconfigured door serves
//               nobody, never everybody. The lease NAME goes to the log line,
//               so reads are attributable per holder and revocable per holder.
//   2. POLICY — GET/HEAD only, and only paths under this org: the repo
//               collection, one repo's resources, /rate_limit. The owner is
//               pinned in the pattern, not taken from the caller.
//   3. MINT   — same plane as the reconcile cron in worker.ts: the broker's
//               service binding (binding.internal/apptoken/<DOOR_APP>). The
//               binding is host-gated to same-account Workers and the grant is
//               the broker registry entry (infra), so the App key never lives
//               here. Tokens are cached below their 1h lifetime; a 401 from
//               GitHub drops the cache and remints ONCE, so a revoked token
//               heals without a redeploy and a real 401 still surfaces.

export type DoorEnv = {
  /** Named bearer leases, one `name:token` per line (or comma-separated).
   *  Worker secret — never in git. Absent or empty ⇒ the door refuses all. */
  DOOR_LEASES?: string;
  /** Broker registry app the mint runs as. The registry (infra) is what caps
   *  this door at read scopes; changing the name here without that entry makes
   *  every mint fail, which is the intended failure direction. */
  DOOR_APP?: string;
  BROKER: Fetcher;
};

export const DEFAULT_DOOR_APP = "bs-door-github-read";

const OWNER = "bounded-systems";

/** Leases below this length never authenticate, even if configured: a
 *  truncated paste must fail at setup time, not guard reads in production. */
const MIN_LEASE_LENGTH = 24;

export function parseLeases(raw: string | undefined): Map<string, string> {
  const leases = new Map<string, string>();
  if (!raw) return leases;
  for (const entry of raw.split(/[\n,]/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep <= 0) continue;
    const name = trimmed.slice(0, sep).trim();
    const token = trimmed.slice(sep + 1).trim();
    if (!name || token.length < MIN_LEASE_LENGTH) continue;
    leases.set(name, token);
  }
  return leases;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Resolve the bearer token to a lease name, or null. Comparison happens on
 *  SHA-256 digests so no code path compares secret bytes positionally. */
export async function authenticate(
  header: string | null,
  leases: Map<string, string>,
): Promise<string | null> {
  if (!header?.startsWith("Bearer ")) return null;
  const presented = header.slice("Bearer ".length).trim();
  if (presented.length < MIN_LEASE_LENGTH) return null;
  const presentedDigest = await sha256Hex(presented);
  for (const [name, token] of leases) {
    if ((await sha256Hex(token)) === presentedDigest) return name;
  }
  return null;
}

const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

export type PolicyResult =
  | { ok: true; upstreamPath: string }
  | { ok: false; status: number; reason: string };

/** The read allowlist. `pathname` arrives WITH the /gh prefix; the upstream
 *  path is what goes to api.github.com. The owner is pinned here — a caller
 *  cannot name one. */
export function checkPath(method: string, pathname: string): PolicyResult {
  if (method !== "GET" && method !== "HEAD") {
    return { ok: false, status: 405, reason: "read-only door: GET/HEAD only" };
  }
  const path = pathname.slice("/gh".length) || "/";
  if (path === "/rate_limit") return { ok: true, upstreamPath: path };
  if (path === `/orgs/${OWNER}/repos`) return { ok: true, upstreamPath: path };
  const repoPrefix = `/repos/${OWNER}/`;
  if (path.startsWith(repoPrefix)) {
    const rest = path.slice(repoPrefix.length);
    const [repo, ...tail] = rest.split("/");
    if (repo && REPO_SEGMENT.test(repo) && tail.every((seg) => seg !== "..")) {
      return { ok: true, upstreamPath: path };
    }
  }
  return {
    ok: false,
    status: 403,
    reason: `outside the read allowlist: /gh/orgs/${OWNER}/repos, /gh/repos/${OWNER}/<repo>/..., /gh/rate_limit`,
  };
}

// Response headers worth relaying. Everything else (cookies, caching hints,
// GitHub's request-id soup) stays behind the door.
const RELAY_HEADERS = [
  "content-type",
  "link",
  "etag",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
];

type TokenCache = { token: string; until: number };
let tokenCache: TokenCache | null = null;

/** Tests only: the cache is module state so concurrent requests share a mint. */
export function resetTokenCacheForTests(): void {
  tokenCache = null;
}

// Installation tokens live one hour; remint comfortably before that so a
// token never expires mid-pagination.
const TOKEN_TTL_MS = 45 * 60 * 1000;

async function mintToken(env: DoorEnv, now: number): Promise<string | null> {
  if (tokenCache && tokenCache.until > now) return tokenCache.token;
  const app = env.DOOR_APP ?? DEFAULT_DOOR_APP;
  const res = await env.BROKER.fetch(`https://binding.internal/apptoken/${app}`, {
    method: "POST",
  });
  if (!res.ok) {
    console.error(`[door] broker mint failed: ${res.status}`);
    return null;
  }
  const { token } = (await res.json()) as { token?: string };
  if (!token) {
    console.error("[door] broker returned no token");
    return null;
  }
  tokenCache = { token, until: now + TOKEN_TTL_MS };
  return token;
}

export type DoorDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export async function handleGithubDoor(
  request: Request,
  env: DoorEnv,
  deps: DoorDeps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  const leases = parseLeases(env.DOOR_LEASES);
  if (leases.size === 0) {
    // Unconfigured ⇒ closed for everyone — and distinguishable from a bad
    // lease, so "the door is down" and "your lease is wrong" never blur.
    return new Response("door has no leases configured — refusing all requests", {
      status: 503,
    });
  }

  const lease = await authenticate(request.headers.get("authorization"), leases);
  if (!lease) return new Response("missing or unknown door lease", { status: 401 });

  const url = new URL(request.url);
  const policy = checkPath(request.method, url.pathname);
  if (!policy.ok) return new Response(policy.reason, { status: policy.status });

  const upstream = `https://api.github.com${policy.upstreamPath}${url.search}`;
  const headers = {
    Authorization: "", // filled per attempt below
    Accept: request.headers.get("accept") ?? "application/vnd.github+json",
    "User-Agent": "bounded-tools-github-door",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // At most two attempts: the second only after a 401 with a fresh mint —
  // that is a cached token dying early, not the caller's error.
  let response: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await mintToken(env, now());
    if (!token) return new Response("token mint failed", { status: 502 });
    headers.Authorization = `Bearer ${token}`;
    response = await fetchImpl(upstream, { method: request.method, headers });
    if (response.status !== 401) break;
    tokenCache = null;
  }
  if (!response) return new Response("token mint failed", { status: 502 });

  const relayed = new Headers({ "cache-control": "no-store" });
  for (const name of RELAY_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) relayed.set(name, value);
  }
  console.log(
    `[door] lease=${lease} ${request.method} ${policy.upstreamPath} -> ${response.status}`,
  );
  return new Response(response.body, { status: response.status, headers: relayed });
}
