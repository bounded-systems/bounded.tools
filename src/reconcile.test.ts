// The load-bearing cases are the refusals and the pagination edges: a non-OK
// page THROWS (a partial denominator quietly shrinks coverage — worse than
// none), malformed rows are dropped without poisoning the batch, and the loop
// terminates on both the total_count contract and an empty page.

import { describe, expect, test } from "bun:test";

import { listInstallationRepos, parseReposPage } from "./reconcile";

describe("parseReposPage", () => {
  test("extracts full_names", () => {
    expect(
      parseReposPage({ repositories: [{ full_name: "a/b" }, { full_name: "a/c" }] }),
    ).toEqual(["a/b", "a/c"]);
  });

  test("drops malformed rows rather than throwing", () => {
    expect(
      parseReposPage({
        repositories: [{ full_name: "a/b" }, {}, { full_name: "" }, { full_name: "a/d" }],
      }),
    ).toEqual(["a/b", "a/d"]);
  });

  test("missing repositories array is an empty page", () => {
    expect(parseReposPage({})).toEqual([]);
  });
});

const page = (names: string[], total: number) =>
  new Response(
    JSON.stringify({ total_count: total, repositories: names.map((n) => ({ full_name: n })) }),
    { status: 200 },
  );

describe("listInstallationRepos", () => {
  test("single page", async () => {
    const fetchImpl = (async () => page(["a/b", "a/c"], 2)) as unknown as typeof fetch;
    expect(await listInstallationRepos("t", fetchImpl)).toEqual(["a/b", "a/c"]);
  });

  test("paginates until total_count is reached", async () => {
    const pages = [page(["a/1"], 3), page(["a/2"], 3), page(["a/3"], 3)];
    let calls = 0;
    const fetchImpl = (async () => pages[calls++]) as unknown as typeof fetch;
    expect(await listInstallationRepos("t", fetchImpl)).toEqual(["a/1", "a/2", "a/3"]);
    expect(calls).toBe(3);
  });

  test("terminates on an empty page even if total_count lies", async () => {
    const pages = [page(["a/1"], 99), page([], 99)];
    let calls = 0;
    const fetchImpl = (async () => pages[calls++]) as unknown as typeof fetch;
    expect(await listInstallationRepos("t", fetchImpl)).toEqual(["a/1"]);
    expect(calls).toBe(2);
  });

  test("a non-OK page throws — partial lists are refused", async () => {
    const pages = [page(["a/1"], 2), new Response("nope", { status: 502 })];
    let calls = 0;
    const fetchImpl = (async () => pages[calls++]) as unknown as typeof fetch;
    await expect(listInstallationRepos("t", fetchImpl)).rejects.toThrow(/page 2: 502/);
  });

  test("sends the token and API headers", async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      captured = init;
      return page(["a/b"], 1);
    }) as unknown as typeof fetch;
    await listInstallationRepos("ghs_tok", fetchImpl);
    const headers = captured?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ghs_tok");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });
});
