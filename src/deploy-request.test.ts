import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * The deploy request the ceremony lane signs, and the gate it may not fall
 * back to (infra#538).
 *
 * `deploy.yml` moved off the `await-approval` comment gate onto the Face ID
 * ceremony. Both checks here exist because THIS REPO IS OUTSIDE infra's
 * `gate-strength` check — that one discovers workflows by file, in infra's own
 * tree, so a lane living here is invisible to it. A rule that holds only where
 * someone remembered to apply it is precisely the defect infra#538 was opened
 * for (the migration had been rolled out to a LIST of lanes rather than to
 * everything matching the predicate), so the rule is restated where it can
 * actually see this repo.
 *
 * WHY THE REQUEST'S OWN FIELDS NEED A CHECK. The ceremony block was copied from
 * desk's deploy.yml, which builds `{repo:"desk",workflow:"deploy.yml",…}`.
 * Those two strings are what the keeper's approval page RENDERS — they are
 * literally what the human reads before touching the sensor. A copy that kept
 * `repo:"desk"` would still start a ceremony, still digest, still redeem:
 * nothing downstream disagrees, because nothing downstream knows which repo
 * asked. The only symptom is a phone naming the wrong deploy, which is the one
 * failure a human-in-the-loop gate cannot absorb.
 *
 * WHY THE CHARSETS ARE HERE TOO. `deploy-digest.mjs` validates before it
 * digests, so an out-of-charset field is a 422 from `/authorize/start` — after
 * the run has started, after the tripwire passed, and after somebody has been
 * told to expect a tap inside a 15-minute window. The regexes are duplicated
 * deliberately: the keeper lives in the PRIVATE infra repo and this one is
 * public, so importing them is not available, and a copy that must not drift is
 * exactly what a test is for.
 */

/**
 * The repository these workflows live in — the value their requests must name.
 * This is the REMOTE's name, not the checkout directory's: in this org those
 * differ (site is cloned as `bounded.tools/` locally — site#32), so reading it
 * off a path would be a coincidence rather than a fact.
 */
const THIS_REPO = "bounded.tools";

const WORKFLOW_DIR = new URL("../.github/workflows/", import.meta.url).pathname;

// deploy-digest.mjs CHECKS, verbatim. If the keeper's loosen, these may follow;
// if they tighten, this fails first, which is the right order.
const REPO_RE = /^[A-Za-z0-9._-]+$/;
const WORKFLOW_RE = /^[A-Za-z0-9._-]+\.ya?ml$/;

const DEPLOY_REQUEST_V1 = "bounded.deploy-request.v1";

type Lane = { file: string; text: string };

const workflows = (): Lane[] =>
  readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => ({ file: f, text: readFileSync(join(WORKFLOW_DIR, f), "utf8") }));

/** Lanes that open a ceremony — found by the request type, not by a list. */
const ceremonyLanes = (): Lane[] =>
  workflows().filter((l) => l.text.includes(`v:"${DEPLOY_REQUEST_V1}"`));

describe("the Face ID ceremony's deploy request", () => {
  test("discovery finds the ceremony lane at all", () => {
    // Without this the next test passes vacuously over an empty set — the
    // "green from a job that did nothing" shape this org keeps meeting. If the
    // request literal is ever reformatted (whitespace inside the jq object,
    // say), this is what says so, rather than the suite quietly measuring
    // nothing.
    const lanes = ceremonyLanes().map((l) => l.file);
    expect(lanes).toEqual(["deploy.yml"]);
  });

  test("the request names ITS OWN repo and ITS OWN file", () => {
    for (const { file, text } of ceremonyLanes()) {
      const repo = /repo:"([^"]*)"/.exec(text)?.[1];
      const workflow = /workflow:"([^"]*)"/.exec(text)?.[1];

      // The approval page renders these; a wrong one asks a human to authorize
      // a deploy of something else.
      expect(`${file}: repo=${repo}`).toBe(`${file}: repo=${THIS_REPO}`);
      expect(`${file}: workflow=${workflow}`).toBe(`${file}: workflow=${basename(file)}`);

      // Would 422 at /authorize/start, mid-run, after the human was pinged.
      expect(REPO_RE.test(repo!)).toBe(true);
      expect(WORKFLOW_RE.test(workflow!)).toBe(true);
    }
  });

  test("no lane keeps the retired comment gate, with or without a ceremony", () => {
    // infra#235: `await-approval` cannot tell the dispatcher from the approver,
    // so it gates nothing against the party it exists to constrain. infra#480
    // retired it; infra#18 removed even the break-glass fallback to it — "a
    // single-boolean bypass to a mechanism known not to work".
    //
    // Matched on `uses:` rather than on the name, so the comments explaining
    // the migration (which have to keep naming it) do not trip their own rule.
    // This is infra's `gate-strength.sh` predicate, restated where it can see
    // this repo.
    const offending = workflows().flatMap(({ file, text }) =>
      text
        .split("\n")
        .filter((line) => /uses:.*await-approval/.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(offending).toEqual([]);
  });
});
