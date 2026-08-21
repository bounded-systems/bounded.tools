import { describe, test, expect } from "bun:test";
import worker from "./worker";

// The App Manifest entry page. What it renders is submitted to GitHub by a
// human click, so two things must hold and both fail silently if they do not:
// the form must target the endpoint that creates the App in the right place,
// and the payload must contain only fields GitHub's schema accepts.

const MANIFEST = {
  name: "example-door",
  url: "https://example.invalid",
  description: "A door.",
  public: false,
  redirect_url: "https://hooks.bounded.tools/app-created",
  default_permissions: { administration: "write", metadata: "read" },
  default_events: [],
};

const b64url = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const get = (qs: string) =>
  worker.fetch(new Request(`https://hooks.bounded.tools/app-create?${qs}`), {} as never);

/** The form's action, exactly — a substring check cannot tell an endpoint from
 *  one embedded in another host's query string. */
const formAction = (html: string) => html.match(/<form action="([^"]*)"/)?.[1];

/** The manifest the page will POST, parsed back out of the textarea. */
const posted = (html: string) => {
  const raw = html.match(/<textarea name="manifest"[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? "";
  return JSON.parse(
    raw
      .replaceAll("&quot;", '"')
      .replaceAll("&gt;", ">")
      .replaceAll("&lt;", "<")
      .replaceAll("&amp;", "&"),
  );
};

describe("/app-create endpoint selection", () => {
  test("defaults to the organization endpoint, so existing URLs are unchanged", async () => {
    const html = await (await get(`m=${b64url(MANIFEST)}`)).text();
    expect(formAction(html)).toBe(
      "https://github.com/organizations/bounded-systems/settings/apps/new",
    );
  });

  test("owner=org honours ?org=", async () => {
    const html = await (await get(`m=${b64url(MANIFEST)}&owner=org&org=acme`)).text();
    expect(formAction(html)).toBe("https://github.com/organizations/acme/settings/apps/new");
  });

  test("owner=user targets the personal endpoint", async () => {
    // A private App installs ONLY on its owner, and ownership cannot be changed
    // after creation — the wrong endpoint means deleting the App and starting
    // over, and both endpoints render a page that works.
    const html = await (await get(`m=${b64url(MANIFEST)}&owner=user`)).text();
    expect(formAction(html)).toBe("https://github.com/settings/apps/new");
  });

  test("owner=user never emits an organization path, even when ?org= is passed", async () => {
    const html = await (await get(`m=${b64url(MANIFEST)}&owner=user&org=acme`)).text();
    expect(html).not.toContain("/organizations/");
  });

  test("the page names the target, because the mistake is otherwise invisible", async () => {
    expect(await (await get(`m=${b64url(MANIFEST)}&owner=user`)).text()).toContain(
      "your user account",
    );
    expect(await (await get(`m=${b64url(MANIFEST)}&owner=org&org=acme`)).text()).toContain("acme");
  });

  test("an unknown owner is refused rather than defaulting to either endpoint", async () => {
    const res = await get(`m=${b64url(MANIFEST)}&owner=organisation`);
    expect(res.status).toBe(400);
  });

  test("a malformed org is still refused", async () => {
    expect((await get(`m=${b64url(MANIFEST)}&org=acme/evil`)).status).toBe(400);
  });
});

describe("/app-create payload hygiene", () => {
  test("$-prefixed keys never reach GitHub", async () => {
    // GitHub's manifest schema has a fixed field set and rejects unknown
    // fields. `$comment` is the org's convention for recording WHY a manifest
    // looks as it does. This page was safe only because its one caller stripped
    // upstream; a caller that did not produced a Create button that silently
    // failed.
    const html = await (
      await get(`m=${b64url({ ...MANIFEST, $comment: "why this exists", $note: "more" })}`)
    ).text();
    const keys = Object.keys(posted(html));
    expect(keys.filter((k) => k.startsWith("$"))).toEqual([]);
    expect(keys).toEqual(Object.keys(MANIFEST));
  });

  test("stripping does not disturb the real fields", async () => {
    const html = await (await get(`m=${b64url({ ...MANIFEST, $comment: "x" })}`)).text();
    expect(posted(html)).toEqual(MANIFEST);
  });

  test("a manifest that is not a JSON object is refused", async () => {
    for (const bad of [b64url([1, 2]), b64url("string"), b64url(null), "not-base64!"]) {
      expect((await get(`m=${bad}`)).status).toBe(400);
    }
  });

  test("a missing ?m= is refused", async () => {
    expect((await get("owner=user")).status).toBe(400);
  });
});
