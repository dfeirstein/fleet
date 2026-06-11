import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldCheckForUpdate, autoUpdateEligible, lockfileChanged, postUpdateAction, THROTTLE_MS } from "./autoupdate.js";

test("shouldCheckForUpdate: no stamp → always check", () => {
  assert.equal(shouldCheckForUpdate(null), true);
});

test("shouldCheckForUpdate: throttles within the 24h window", () => {
  assert.equal(shouldCheckForUpdate(THROTTLE_MS - 1), false);
  assert.equal(shouldCheckForUpdate(0), false);
});

test("shouldCheckForUpdate: checks again once the window has passed", () => {
  assert.equal(shouldCheckForUpdate(THROTTLE_MS), true);
  assert.equal(shouldCheckForUpdate(THROTTLE_MS + 60_000), true);
});

test("autoUpdateEligible: clean main with no opt-out is eligible", () => {
  assert.deepEqual(autoUpdateEligible({ branch: "main", clean: true, optOut: false }), {
    ok: true,
    reason: "",
  });
});

test("autoUpdateEligible: opt-out wins over everything", () => {
  const r = autoUpdateEligible({ branch: "main", clean: true, optOut: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /FLEET_NO_AUTOUPDATE/);
});

test("autoUpdateEligible: a feature branch is exempt", () => {
  const r = autoUpdateEligible({ branch: "fleet/installer", clean: true, optOut: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not main/);
});

test("autoUpdateEligible: a dirty tree is exempt", () => {
  const r = autoUpdateEligible({ branch: "main", clean: false, optOut: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /uncommitted/);
});

test("lockfileChanged: true only when package-lock.json moved", () => {
  assert.equal(lockfileChanged(["src/cli.ts", "package-lock.json"]), true);
  assert.equal(lockfileChanged(["src/cli.ts", "README.md"]), false);
  assert.equal(lockfileChanged([]), false);
});

test("postUpdateAction: rolls back only when the lockfile moved AND npm ci failed", () => {
  assert.equal(postUpdateAction({ lockfileMoved: true, npmCiOk: false }), "rollback");
});

test("postUpdateAction: commits when npm ci succeeded", () => {
  assert.equal(postUpdateAction({ lockfileMoved: true, npmCiOk: true }), "commit");
});

test("postUpdateAction: a failed npm ci is irrelevant when the lockfile didn't move", () => {
  // No lockfile change → npm ci was never run; never roll back a clean code-only pull.
  assert.equal(postUpdateAction({ lockfileMoved: false, npmCiOk: false }), "commit");
  assert.equal(postUpdateAction({ lockfileMoved: false, npmCiOk: true }), "commit");
});
