// Regression test for Bug 1 (bughunt 2026-06-13): a failed registry lookup was
// cached as a fresh, today-stamped fact — so isFresh() reused it for the full
// 7-day TTL (never retried) and audit-docs read it as a current fact (fail
// OPEN). The fix: an unresolved lookup is not a fresh fact — leave its
// `fetchedAt` empty so it re-fetches next run and the audit gate flags it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currency } from "./currency.js";

const DEP = "definitely-not-a-real-package-xyz";

/** A temp project dir declaring one devDependency for currency to resolve. */
function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-currency-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { [DEP]: "^1.0.0" } }));
  return dir;
}

test("currency: a failed registry lookup is NOT stamped fresh (empty fetchedAt → retried, audit-flagged)", async () => {
  const dir = tmpProject();
  const realFetch = globalThis.fetch;
  // Every lookup fails — the failure class the bug collapsed to a fresh fact.
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  try {
    const res = await currency({ cwd: dir, force: false });
    const entry = res.entries.find((e) => e.name === DEP);
    assert.ok(entry, "the failed dep is still listed");
    assert.equal(entry!.latest, undefined, "latest stays unresolved");
    // The bug stamped fetchedAt = today() so isFresh() read it as current. The
    // fix leaves it empty → isFresh() false → audit-docs flags it (fail closed).
    assert.equal(entry!.fetchedAt, "", "a failed lookup must not carry a fresh fetch date");

    // Because it is not fresh, the NEXT run re-fetches it (no 7-day silent reuse).
    const res2 = await currency({ cwd: dir, force: false });
    assert.ok(res2.refetched >= 1, "an unresolved entry is retried, not served from cache");
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
