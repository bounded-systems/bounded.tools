// Reconcile (.github-private#481 increment 4): the coverage denominator.
//
// The snapshot's `coverage_complete` can only ever be true against a list of
// repos the App is *installed on* — inferring the fleet from who has reported
// in would claim completeness exactly when coverage is worst. This module
// fetches that list: a broker-minted installation token (service binding —
// metadata:read, nothing else), then GET /installation/repositories, paginated.
//
// Pure parsing is separated from fetching so the pagination and shape rules are
// unit-tested without a network.

export type ReposPage = {
  total_count?: number;
  repositories?: Array<{ full_name?: string }>;
};

/** Extract full_names from one page, dropping malformed entries rather than
 *  throwing — a single odd row must not turn the whole reconcile into "unknown". */
export function parseReposPage(page: ReposPage): string[] {
  if (!Array.isArray(page.repositories)) return [];
  return page.repositories
    .map((r) => r?.full_name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

/** The GitHub pagination loop, fetch injectable. Throws on any non-OK page:
 *  a partial list is WORSE than no list, because it would name innocent repos
 *  as unobserved and quietly shrink the denominator. */
export async function listInstallationRepos(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetchImpl(
      `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "bounded-tools-reconcile",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!res.ok) throw new Error(`installation/repositories page ${page}: ${res.status}`);
    const body = (await res.json()) as ReposPage;
    const batch = parseReposPage(body);
    names.push(...batch);
    const total = body.total_count ?? 0;
    if (batch.length === 0 || names.length >= total) break;
  }
  return names;
}
