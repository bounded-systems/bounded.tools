// Every lane that opens a keeper ceremony must also announce it (infra#553).
//
// The failure this pins is not a broken notice — it is a lane that never had
// one. infra#552 gave seven lanes a push; this repo was not in that scope, and
// on 2026-08-31 a ceremony here opened, waited its full window and reached no
// phone. Nothing was red, because nothing was checked.
//
// It reads the workflow FILES rather than a list of lane names, so a new
// ceremony lane is covered the day it is added rather than the day someone
// remembers to add it here.
import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = ".github/workflows";
const workflows = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

test("every lane that opens a ceremony pushes an approval notice before waiting", () => {
  const missing: string[] = [];
  for (const f of workflows) {
    const src = readFileSync(join(DIR, f), "utf8");
    if (!src.includes("authorize/start")) continue;
    // The notice must exist, and must come BEFORE the wait — a notice after the
    // wait is sent to a human who has already approved, or never sent at all.
    const notice = src.indexOf("desk.bounded.tools/approval");
    const wait = src.indexOf("Wait for the Face ID");
    // `wait === -1` is a FAILURE, not a reason to skip the ordering check. A
    // ceremony lane always waits; if this marker stops matching, the ordering
    // assertion would silently disable itself and this test would go on
    // passing while proving nothing — found by mutating the step's name.
    if (notice === -1 || wait === -1 || notice > wait) missing.push(f);
  }
  expect(missing).toEqual([]);
});

test("the ceremony step publishes the approve URL the notice needs", () => {
  // approve_url was a local shell variable in every lane that had this bug: the
  // notice step reads steps.ceremony.outputs.approve_url, so a lane that never
  // echoes it sends a notice with an empty URL and reports "skipped" forever.
  for (const f of workflows) {
    const src = readFileSync(join(DIR, f), "utf8");
    if (!src.includes("authorize/start")) continue;
    expect(src).toContain('echo "approve_url=$approve_url" >> "$GITHUB_OUTPUT"');
  }
});

test("the lane can mint the OIDC token the notice is authorized by", () => {
  // A job-level `permissions:` block silently overrides the workflow-level
  // grant, and the notice then reports "skipped — no OIDC token" on every run.
  // infra#552 found this shape by inspection; here it is a test.
  for (const f of workflows) {
    const src = readFileSync(join(DIR, f), "utf8");
    if (!src.includes("desk.bounded.tools/approval")) continue;
    expect(src).toContain("id-token: write");
  }
});
